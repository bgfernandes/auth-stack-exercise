/**
 * The routes over an in-memory documents service, with tokens from the fake OP of `@auth-stack/auth/testing`:
 * the wire format, the status of each outcome of §6.5, the scope each route needs, and that the user context
 * handed to the service carries the caller's token. The real service, SpiceDB included, is covered by the
 * integration test (dashboard-api.integration.test.ts).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { type FastifyInstance } from 'fastify';

import { createBearerVerifier, type ScopeResolver } from '@auth-stack/auth';
import { createFakeOp, type FakeOp } from '@auth-stack/auth/testing';
import { type Consistency } from '@auth-stack/authz';
import {
  DocumentsError,
  parseDocumentShares,
  parseDocumentValues,
  type Document,
  type DocumentsService,
  type DocumentShares,
  type PersonalWorkspace,
  type Project,
  type VisibleDocument,
} from '@auth-stack/documents';
import { createHttpDocumentsClient, type DocumentsClient } from '@auth-stack/documents/client';
import { type UserContext } from '@auth-stack/tenancy/client';

import { buildApp } from './app';

const PROJECT = 'project-1';
const DASHBOARD_WEB = 'dashboard-web';
const READ_ONLY = 'read-only-client';
const ACME = randomUUID();
const ACME_NAME = 'Acme';

type Access = 'edit' | 'view';

/**
 * Documents with an access table instead of SpiceDB: who may edit or view each, who may share, who is a member.
 * The outcomes follow the service's contract (§6.5): `forbidden` when the user may view, `not_found` otherwise.
 */
class FakeDocuments implements DocumentsService {
  readonly documents = new Map<string, Document>();
  readonly projects = new Map<string, Project>();
  readonly access = new Map<string, Map<string, Access>>();
  readonly sharers = new Set<string>();
  readonly members = new Set<string>();
  readonly shares = new Map<string, DocumentShares>();
  /** Which organizations each user may create projects in. */
  readonly creators = new Map<string, Set<string>>();
  readonly calls: { method: string; user: UserContext; consistency?: Consistency }[] = [];

  add(name: string, access: Record<string, Access>): Document {
    const document: Document = {
      id: randomUUID(),
      projectId: randomUUID(),
      organizationId: ACME,
      name,
      value1: 'one',
      value2: 'two',
      zedtoken: 'token-1',
      updatedAt: new Date('2026-10-18T10:00:00.000Z'),
      updatedBy: 'seed',
    };
    this.documents.set(document.id, document);
    this.projects.set(document.projectId, {
      id: document.projectId,
      organizationId: ACME,
      name: `${name} project`,
      isPersonal: false,
      createdAt: document.updatedAt,
    });
    for (const [sub, level] of Object.entries(access)) {
      if (!this.access.has(sub)) this.access.set(sub, new Map());
      this.access.get(sub)?.set(document.id, level);
    }
    return document;
  }

  private accessOf(user: UserContext, id: string): Access | undefined {
    return this.access.get(user.sub)?.get(id);
  }

  private denied(user: UserContext, id: string): DocumentsError {
    return this.accessOf(user, id) === 'view'
      ? new DocumentsError('forbidden', 'required')
      : new DocumentsError('not_found', 'document not found');
  }

  ensurePersonalProject(user: UserContext, organizationId: string): Promise<PersonalWorkspace> {
    this.calls.push({ method: 'ensurePersonalProject', user });
    if (!this.creators.get(user.sub)?.has(organizationId)) {
      return Promise.reject(new DocumentsError('not_found', 'organization not found'));
    }
    const existing = [...this.projects.values()].find(
      (project) => project.organizationId === organizationId && project.isPersonal,
    );
    if (existing) {
      const document = [...this.documents.values()].find((row) => row.projectId === existing.id);
      if (!document) throw new Error('personal project without its document');
      return Promise.resolve({ project: existing, document, created: false });
    }
    const at = new Date('2026-10-18T11:00:00.000Z');
    const project: Project = {
      id: randomUUID(),
      organizationId,
      name: 'Personal',
      isPersonal: true,
      createdAt: at,
    };
    const document: Document = {
      id: randomUUID(),
      projectId: project.id,
      organizationId,
      name: 'Welcome',
      value1: 'Hello',
      value2: 'World',
      zedtoken: 'token-2',
      updatedAt: at,
      updatedBy: user.sub,
    };
    this.projects.set(project.id, project);
    this.documents.set(document.id, document);
    if (!this.access.has(user.sub)) this.access.set(user.sub, new Map());
    this.access.get(user.sub)?.set(document.id, 'edit');
    return Promise.resolve({ project, document, created: true });
  }

  listVisibleDocuments(user: UserContext, consistency: Consistency): Promise<VisibleDocument[]> {
    this.calls.push({ method: 'listVisibleDocuments', user, consistency });
    const rows: VisibleDocument[] = [];
    for (const [id, level] of this.access.get(user.sub) ?? []) {
      const document = this.documents.get(id);
      const project = document && this.projects.get(document.projectId);
      if (!document || !project) continue;
      rows.push({
        id,
        name: document.name,
        project: { id: project.id, name: project.name },
        organization: { id: document.organizationId, name: ACME_NAME },
        canEdit: level === 'edit',
        canShare: this.sharers.has(user.sub),
        updatedAt: document.updatedAt,
      });
    }
    return Promise.resolve(rows);
  }

  getDocumentForEdit(user: UserContext, id: string): Promise<Document> {
    this.calls.push({ method: 'getDocumentForEdit', user });
    const document = this.documents.get(id);
    if (!document || this.accessOf(user, id) !== 'edit')
      return Promise.reject(this.denied(user, id));
    return Promise.resolve(document);
  }

  updateDocument(user: UserContext, id: string, values: unknown): Promise<Document> {
    this.calls.push({ method: 'updateDocument', user });
    const parsed = parseDocumentValues(values);
    const document = this.documents.get(id);
    if (!document || this.accessOf(user, id) !== 'edit')
      return Promise.reject(this.denied(user, id));
    const updated = {
      ...document,
      ...parsed,
      zedtoken: 'token-3',
      updatedAt: new Date('2026-10-18T12:00:00.000Z'),
      updatedBy: user.sub,
    };
    this.documents.set(id, updated);
    return Promise.resolve(updated);
  }

  getDocumentShares(user: UserContext, id: string): Promise<DocumentShares> {
    this.calls.push({ method: 'getDocumentShares', user });
    const document = this.documents.get(id);
    if (!document || !this.sharers.has(user.sub)) return Promise.reject(this.denied(user, id));
    return Promise.resolve(this.shares.get(id) ?? { editors: [], viewers: [] });
  }

  setDocumentShares(user: UserContext, id: string, shares: unknown): Promise<Document> {
    this.calls.push({ method: 'setDocumentShares', user });
    const parsed = parseDocumentShares(shares);
    const document = this.documents.get(id);
    if (!document || !this.sharers.has(user.sub)) return Promise.reject(this.denied(user, id));
    if ([...parsed.editors, ...parsed.viewers].some((sub) => !this.members.has(sub)))
      return Promise.reject(new DocumentsError('not_a_member', 'outside the organization'));
    this.shares.set(id, parsed);
    const updated = { ...document, zedtoken: 'token-4' };
    this.documents.set(id, updated);
    return Promise.resolve(updated);
  }
}

const scopes: ScopeResolver = {
  resolveScopes: (claims) =>
    Promise.resolve(
      new Set(
        claims.client_id === DASHBOARD_WEB
          ? ['documents:read', 'documents:write']
          : ['documents:read'],
      ),
    ),
};

describe('dashboard-api', () => {
  let op: FakeOp;
  let app: FastifyInstance;
  let service: FakeDocuments;
  let alice: string;
  let bob: string;
  let carol: string;

  const now = () => Math.floor(Date.now() / 1000);
  async function tokenFor(sub: string, client = DASHBOARD_WEB): Promise<string> {
    return op.sign({
      iss: op.issuer,
      sub,
      aud: [client, PROJECT],
      client_id: client,
      iat: now(),
      exp: now() + 600,
      jti: randomUUID(),
    });
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = (token: string) => ({
    ...bearer(token),
    'content-type': 'application/json',
  });

  async function build(
    deps: Partial<Parameters<typeof buildApp>[0]> = {},
  ): Promise<FastifyInstance> {
    const built = await buildApp({
      service,
      verifier: createBearerVerifier({
        issuer: op.issuer,
        audience: PROJECT,
        jwksUrl: op.metadata.jwks_uri as string,
        fetch: op.fetch,
      }),
      scopes,
      logLevel: 'silent',
      ...deps,
    });
    await built.ready();
    return built;
  }

  beforeAll(async () => {
    op = await createFakeOp({ clientId: DASHBOARD_WEB, projectId: PROJECT });
    alice = await tokenFor('alice');
    bob = await tokenFor('bob');
    carol = await tokenFor('carol');
  });

  beforeEach(async () => {
    service = new FakeDocuments();
    service.sharers.add('alice');
    for (const sub of ['alice', 'bob', 'carol']) service.members.add(sub);
    service.creators.set('alice', new Set([ACME]));
    app = await build();
  });

  afterAll(() => app.close());

  it('serves the health endpoint without a token and denies everything else without one', async () => {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    const denied = await app.inject({ url: '/documents' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Bearer');
  });

  describe('GET /documents', () => {
    it('lists what the caller may view in the wire format, at minimize_latency, with the caller as context', async () => {
      const budget = service.add('Budget', { alice: 'edit', carol: 'view' });
      const payroll = service.add('Payroll', { alice: 'edit' });
      const response = await app.inject({ url: '/documents', headers: bearer(carol) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        documents: [
          {
            id: budget.id,
            name: 'Budget',
            project: { id: budget.projectId, name: 'Budget project' },
            organization: { id: ACME, name: 'Acme' },
            can_edit: false,
            can_share: false,
            updated_at: '2026-10-18T10:00:00.000Z',
          },
        ],
      });
      const forAlice = await app.inject({ url: '/documents', headers: bearer(alice) });
      expect(forAlice.json<{ documents: { id: string; can_edit: boolean }[] }>().documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: budget.id, can_edit: true, can_share: true }),
          expect.objectContaining({ id: payroll.id, can_edit: true, can_share: true }),
        ]),
      );
      expect((await app.inject({ url: '/documents', headers: bearer(bob) })).json()).toEqual({
        documents: [],
      });
      expect(service.calls.map((call) => call.consistency?.level)).toEqual(
        Array.from({ length: 3 }, () => 'minimize_latency'),
      );
      expect(service.calls[0]?.user).toEqual({ sub: 'carol', accessToken: carol });
    });
  });

  describe('GET /documents/:id', () => {
    it('answers the document to an editor, 403 to a viewer, 404 to anyone else and for any other id', async () => {
      const budget = service.add('Budget', { alice: 'edit', carol: 'view' });
      const own = await app.inject({ url: `/documents/${budget.id}`, headers: bearer(alice) });
      expect(own.statusCode).toBe(200);
      expect(own.json()).toEqual({
        id: budget.id,
        project_id: budget.projectId,
        organization_id: ACME,
        name: 'Budget',
        value_1: 'one',
        value_2: 'two',
        updated_at: '2026-10-18T10:00:00.000Z',
        updated_by: 'seed',
      });
      const readOnly = await app.inject({ url: `/documents/${budget.id}`, headers: bearer(carol) });
      expect(readOnly.statusCode).toBe(403);
      expect(readOnly.json()).toEqual({ error: 'forbidden' });
      for (const [token, id] of [
        [bob, budget.id],
        [alice, randomUUID()],
        [alice, 'not-a-uuid'],
      ] as const) {
        const response = await app.inject({ url: `/documents/${id}`, headers: bearer(token) });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'not_found' });
      }
    });
  });

  describe('PUT /documents/:id', () => {
    const values = { value_1: 'Approved spend', value_2: '120000' };

    it('stores the values for an editor and answers the updated document', async () => {
      const budget = service.add('Budget', { alice: 'edit', carol: 'view' });
      const response = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}`,
        headers: json(alice),
        payload: values,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: budget.id,
        project_id: budget.projectId,
        organization_id: ACME,
        name: 'Budget',
        value_1: 'Approved spend',
        value_2: '120000',
        updated_at: '2026-10-18T12:00:00.000Z',
        updated_by: 'alice',
      });
      expect(service.documents.get(budget.id)).toMatchObject({
        value1: 'Approved spend',
        value2: '120000',
      });
    });

    it('answers 403 to a viewer and 404 to anyone else, the §6.5 rule', async () => {
      const budget = service.add('Budget', { alice: 'edit', carol: 'view' });
      const readOnly = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}`,
        headers: json(carol),
        payload: values,
      });
      expect(readOnly.statusCode).toBe(403);
      expect(readOnly.json()).toEqual({ error: 'forbidden' });
      const unseen = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}`,
        headers: json(bob),
        payload: values,
      });
      expect(unseen.statusCode).toBe(404);
      expect(unseen.json()).toEqual({ error: 'not_found' });
      expect(service.documents.get(budget.id)).toMatchObject({ value1: 'one', value2: 'two' });
    });

    it('answers 400 invalid_input to a body of the wrong shape or with values the service refuses', async () => {
      const budget = service.add('Budget', { alice: 'edit' });
      for (const payload of [
        { value1: 'camel', value2: 'case' },
        { value_1: 'only one' },
        { value_1: '', value_2: 'empty' },
        { value_1: 'x'.repeat(201), value_2: 'long' },
        'not an object',
      ]) {
        const response = await app.inject({
          method: 'PUT',
          url: `/documents/${budget.id}`,
          headers: json(alice),
          payload: JSON.stringify(payload),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_input' });
      }
      const noBody = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}`,
        headers: bearer(alice),
      });
      expect(noBody.statusCode).toBe(400);
      expect(noBody.json()).toEqual({ error: 'invalid_input' });
      expect(service.documents.get(budget.id)).toMatchObject({ value1: 'one', value2: 'two' });
    });

    it('needs documents:write, which the read-only client does not hold', async () => {
      const budget = service.add('Budget', { alice: 'edit' });
      const response = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}`,
        headers: json(await tokenFor('alice', READ_ONLY)),
        payload: values,
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="documents:write"',
      );
      expect(response.json()).toEqual({ error: 'insufficient_scope' });
      expect(service.calls).toEqual([]);
    });

    it('keeps the status of a request Fastify itself refuses, with the generic body', async () => {
      const budget = service.add('Budget', { alice: 'edit' });
      const response = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}`,
        headers: { ...bearer(alice), 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'value_1=a&value_2=b',
      });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toEqual({ error: 'bad_request' });
    });
  });

  describe('GET /documents/:id/shares', () => {
    it('answers the shares to whoever may share, 403 to a viewer, 404 to anyone else', async () => {
      const budget = service.add('Budget', { alice: 'edit', carol: 'view' });
      service.shares.set(budget.id, { editors: ['bob'], viewers: ['carol'] });
      const response = await app.inject({
        url: `/documents/${budget.id}/shares`,
        headers: bearer(alice),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ editors: ['bob'], viewers: ['carol'] });
      const viewer = await app.inject({
        url: `/documents/${budget.id}/shares`,
        headers: bearer(carol),
      });
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json()).toEqual({ error: 'forbidden' });
      const stranger = await app.inject({
        url: `/documents/${budget.id}/shares`,
        headers: bearer(bob),
      });
      expect(stranger.statusCode).toBe(404);
      expect(stranger.json()).toEqual({ error: 'not_found' });
      expect(service.calls.at(-1)).toEqual({
        method: 'getDocumentShares',
        user: { sub: 'bob', accessToken: bob },
      });
    });
  });

  describe('PUT /documents/:id/shares', () => {
    it('replaces the shares for whoever may share, 403 for a viewer, 404 for anyone else', async () => {
      const budget = service.add('Budget', { alice: 'edit', carol: 'view' });
      const shares = { editors: ['bob'], viewers: ['carol'] };
      const response = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}/shares`,
        headers: json(alice),
        payload: shares,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: budget.id, name: 'Budget' });
      expect(service.shares.get(budget.id)).toEqual(shares);

      const viewer = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}/shares`,
        headers: json(carol),
        payload: shares,
      });
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json()).toEqual({ error: 'forbidden' });
      const stranger = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}/shares`,
        headers: json(bob),
        payload: shares,
      });
      expect(stranger.statusCode).toBe(404);
      expect(stranger.json()).toEqual({ error: 'not_found' });
    });

    it('answers 400 not_a_member for a user outside the organization and invalid_input for a bad set', async () => {
      const budget = service.add('Budget', { alice: 'edit' });
      const outsider = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}/shares`,
        headers: json(alice),
        payload: { editors: ['mallory'], viewers: [] },
      });
      expect(outsider.statusCode).toBe(400);
      expect(outsider.json()).toEqual({ error: 'not_a_member' });
      for (const payload of [
        { editors: ['bob'] },
        { editors: ['bob'], viewers: ['bob'] },
        { editors: ['a:b'], viewers: [] },
        { editors: 'bob', viewers: [] },
      ]) {
        const response = await app.inject({
          method: 'PUT',
          url: `/documents/${budget.id}/shares`,
          headers: json(alice),
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_input' });
      }
      expect(service.shares.size).toBe(0);
    });

    it('needs documents:write', async () => {
      const budget = service.add('Budget', { alice: 'edit' });
      const response = await app.inject({
        method: 'PUT',
        url: `/documents/${budget.id}/shares`,
        headers: json(await tokenFor('alice', READ_ONLY)),
        payload: { editors: [], viewers: [] },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="documents:write"',
      );
    });
  });

  describe('POST /organizations/:id/personal-project', () => {
    it('creates the workspace once and answers the existing one afterwards', async () => {
      const first = await app.inject({
        method: 'POST',
        url: `/organizations/${ACME}/personal-project`,
        headers: bearer(alice),
      });
      expect(first.statusCode).toBe(200);
      const body = first.json<{
        project: Record<string, unknown>;
        document: Record<string, unknown>;
        created: boolean;
      }>();
      expect(body.created).toBe(true);
      expect(body.project).toEqual({
        id: expect.any(String) as unknown,
        organization_id: ACME,
        name: 'Personal',
        is_personal: true,
        created_at: '2026-10-18T11:00:00.000Z',
      });
      expect(body.document).toEqual({
        id: expect.any(String) as unknown,
        project_id: body.project.id,
        organization_id: ACME,
        name: 'Welcome',
        value_1: 'Hello',
        value_2: 'World',
        updated_at: '2026-10-18T11:00:00.000Z',
        updated_by: 'alice',
      });
      const second = await app.inject({
        method: 'POST',
        url: `/organizations/${ACME}/personal-project`,
        headers: bearer(alice),
      });
      expect(second.json()).toEqual({ ...body, created: false });
    });

    it('answers 404 for an organization the caller cannot create in, and for an id that is not one', async () => {
      for (const [token, id] of [
        [bob, ACME],
        [alice, randomUUID()],
        [alice, 'not-a-uuid'],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/organizations/${id}/personal-project`,
          headers: bearer(token),
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'not_found' });
      }
      expect(service.projects.size).toBe(0);
    });

    it('needs documents:write', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/organizations/${ACME}/personal-project`,
        headers: bearer(await tokenFor('alice', READ_ONLY)),
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="documents:write"',
      );
    });
  });

  describe('errors', () => {
    it('hides anything but a documents verdict behind a 500, and denies every read without the scope', async () => {
      const failing = {
        ...service,
        listVisibleDocuments: () => Promise.reject(new Error('database on fire')),
      } as unknown as DocumentsService;
      const broken = await build({ service: failing });
      const internal = await broken.inject({ url: '/documents', headers: bearer(alice) });
      expect(internal.statusCode).toBe(500);
      expect(internal.body).toBe('{"error":"internal"}');
      await broken.close();

      const none: ScopeResolver = { resolveScopes: () => Promise.resolve(new Set()) };
      const bare = await build({ scopes: none });
      const response = await bare.inject({ url: '/documents', headers: bearer(alice) });
      expect(response.statusCode).toBe(403);
      expect(response.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="documents:read"',
      );
      await bare.close();
    });
  });

  /**
   * The contract between the two sides (ticket 19): the HTTP client of `@auth-stack/documents/client` over this
   * app listening on a port, so what the routes answer is what the client parses, and a refusal arrives as the
   * client's error with the API's status and code.
   */
  describe('through the HTTP client', () => {
    let listening: FastifyInstance;
    let client: DocumentsClient;

    beforeEach(async () => {
      listening = await build();
      const address = await listening.listen({ port: 0, host: '127.0.0.1' });
      client = createHttpDocumentsClient({ baseUrl: address });
    });

    afterEach(() => listening.close());

    it('round-trips every call as the user, and maps each refusal to its status and code', async () => {
      const budget = service.add('Budget', { alice: 'edit', carol: 'view' });
      const user = { sub: 'alice', accessToken: alice };

      expect(await client.listVisibleDocuments({ sub: 'carol', accessToken: carol })).toEqual([
        {
          id: budget.id,
          name: 'Budget',
          project: { id: budget.projectId, name: 'Budget project' },
          organization: { id: ACME, name: 'Acme' },
          canEdit: false,
          canShare: false,
          updatedAt: budget.updatedAt,
        },
      ]);
      const read = await client.getDocumentForEdit(user, budget.id);
      expect(read).toEqual({
        id: budget.id,
        projectId: budget.projectId,
        organizationId: ACME,
        name: 'Budget',
        value1: 'one',
        value2: 'two',
        updatedAt: budget.updatedAt,
        updatedBy: 'seed',
      });
      expect('zedtoken' in read).toBe(false);
      const updated = await client.updateDocument(user, budget.id, {
        value1: 'three',
        value2: 'four',
      });
      expect(updated).toMatchObject({ value1: 'three', value2: 'four', updatedBy: 'alice' });
      const shared = await client.setDocumentShares(user, budget.id, {
        editors: ['bob'],
        viewers: [],
      });
      expect(shared).toMatchObject({ id: budget.id, value1: 'three' });
      expect(service.shares.get(budget.id)).toEqual({ editors: ['bob'], viewers: [] });
      expect(await client.getDocumentShares(user, budget.id)).toEqual({
        editors: ['bob'],
        viewers: [],
      });
      const workspace = await client.ensurePersonalProject(user, ACME);
      expect(workspace).toMatchObject({
        created: true,
        project: { name: 'Personal', isPersonal: true },
      });
      expect(workspace.document).toMatchObject({
        name: 'Welcome',
        projectId: workspace.project.id,
      });
      expect(service.calls.map((call) => call.user.accessToken)).toEqual([
        carol,
        alice,
        alice,
        alice,
        alice,
        alice,
      ]);

      const viewer = { sub: 'carol', accessToken: carol };
      await expect(client.getDocumentForEdit(viewer, budget.id)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
      await expect(
        client.getDocumentForEdit({ sub: 'bob', accessToken: bob }, budget.id),
      ).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
      await expect(
        client.updateDocument(user, budget.id, { value1: '', value2: 'x' }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_input',
      });
      await expect(
        client.setDocumentShares(user, budget.id, { editors: ['ghost'], viewers: [] }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'not_a_member',
      });
      await expect(
        client.listVisibleDocuments({ sub: 'alice', accessToken: 'not-a-token' }),
      ).rejects.toMatchObject({
        status: 401,
        code: 'invalid_token',
      });
      await expect(
        client.ensurePersonalProject(
          { sub: 'alice', accessToken: await tokenFor('alice', READ_ONLY) },
          ACME,
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'insufficient_scope',
      });
    });
  });
});
