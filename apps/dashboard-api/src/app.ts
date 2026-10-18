/**
 * `dashboard-api` (docs/README.md §3.1, §6.5, §6.7): the documents domain behind bearer tokens. Every route but
 * the health endpoint needs a verified token of the project (the plugin of `@auth-stack/auth/fastify`, deny by
 * default) and the scope its row of §6.7 names; the handlers then act for the token's `sub`, forwarding the
 * token itself as the user context the service passes to tenancy, and let the service ask SpiceDB at the
 * consistency §7.3 assigns to each operation. The wire format is the snake_case JSON of
 * `@auth-stack/documents/client`, and an error body is `{ error: <code> }` and nothing else: the reason goes to
 * the log.
 */
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';

import {
  BearerError,
  type BearerVerifier,
  type Principal,
  type ScopeResolver,
} from '@auth-stack/auth';
import { apiServerOptions, bearerPlugin, echoRequestId } from '@auth-stack/auth/fastify';
import { minimizeLatency } from '@auth-stack/authz';
import {
  isDocumentsError,
  type DocumentsErrorCode,
  type DocumentsService,
} from '@auth-stack/documents';
import {
  DOCUMENTS_API_SCOPES,
  documentSharesWire,
  documentValuesWire,
  toDocumentWire,
  toPersonalWorkspaceWire,
  toVisibleDocumentWire,
} from '@auth-stack/documents/client';
import { type UserContext } from '@auth-stack/tenancy/client';

export interface AppDeps {
  service: DocumentsService;
  verifier: BearerVerifier;
  scopes: ScopeResolver;
  /** A logger instance instead of Fastify's own (tests pass a silent one). */
  logger?: FastifyBaseLogger;
  logLevel?: string;
}

const STATUS_OF: Record<DocumentsErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  not_a_member: 400,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER = /^Bearer\s+(\S+)$/i;

/** The verified caller; the plugin set it before any handler below ran. */
function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw new Error('no principal on a protected route');
  return request.principal;
}

/**
 * The user the service acts for: the token's `sub`, and the token as presented, which the service forwards to
 * tenancy for organization names (§6.6: data travels on the user's own token). The plugin already verified it.
 */
function userOf(request: FastifyRequest): UserContext {
  const match = BEARER.exec(request.headers.authorization?.trim() ?? '');
  if (!match?.[1]) throw new Error('no bearer token on a protected route');
  return { sub: principalOf(request).sub, accessToken: match[1] };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { service } = deps;
  const app = Fastify(
    apiServerOptions(
      deps.logger ? { logger: deps.logger } : deps.logLevel ? { logLevel: deps.logLevel } : {},
    ),
  );
  echoRequestId(app);
  await app.register(bearerPlugin, { verifier: deps.verifier, scopes: deps.scopes });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (isDocumentsError(error)) {
      return reply.code(STATUS_OF[error.code]).send({ error: error.code });
    }
    if (error instanceof BearerError) {
      return reply
        .code(error.status)
        .header('www-authenticate', error.challenge)
        .send({ error: error.code });
    }
    // The service's own validation (value lengths, the share set), or Fastify's schema validation.
    if (error instanceof ZodError || isValidationError(error)) {
      return reply.code(400).send({ error: 'invalid_input' });
    }
    // Fastify's own verdicts on the request (an unsupported media type, a body too large) keep their status.
    const status = clientErrorStatus(error);
    if (status !== undefined) {
      return reply.code(status).send({ error: 'bad_request' });
    }
    // Anything else is a bug or an outage: logged in full, answered with nothing of it (§9).
    request.log.error({ err: error }, 'request.failed');
    return reply.code(500).send({ error: 'internal' });
  });

  app.get('/health', { config: { public: true } }, () => ({ status: 'ok' }));

  app.get(
    '/documents',
    { preHandler: app.requireScope(DOCUMENTS_API_SCOPES.read) },
    async (request) => {
      // The listing level of §7.3: a cached snapshot, stale by up to one quantization window, for everyone
      // including the user who just wrote; every content read is gated per row with the row's token.
      const rows = await service.listVisibleDocuments(userOf(request), minimizeLatency);
      return { documents: rows.map(toVisibleDocumentWire) };
    },
  );

  // The edit page's read (§7.3): `edit` at least as fresh as the row's token; `view` only is 403, nothing is 404.
  app.get<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: app.requireScope(DOCUMENTS_API_SCOPES.read) },
    async (request) => {
      const document = await service.getDocumentForEdit(userOf(request), request.params.id);
      return toDocumentWire(document);
    },
  );

  // A content write (§7.3): `edit` fully consistent, the check's token stored with the values.
  app.put<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: app.requireScope(DOCUMENTS_API_SCOPES.write) },
    async (request, reply) => {
      const body = documentValuesWire.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_input' });
      const document = await service.updateDocument(userOf(request), request.params.id, {
        value1: body.data.value_1,
        value2: body.data.value_2,
      });
      return toDocumentWire(document);
    },
  );

  // The share action (§6.8, §7.3): replaces the direct shares; `share` fully consistent, the write's token stored.
  app.put<{ Params: { id: string } }>(
    '/documents/:id/shares',
    { preHandler: app.requireScope(DOCUMENTS_API_SCOPES.write) },
    async (request, reply) => {
      const body = documentSharesWire.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_input' });
      const document = await service.setDocumentShares(
        userOf(request),
        request.params.id,
        body.data,
      );
      return toDocumentWire(document);
    },
  );

  // §6.4: idempotent; the organization must grant `create_project` to the caller, else it is not found.
  app.post<{ Params: { id: string } }>(
    '/organizations/:id/personal-project',
    { preHandler: app.requireScope(DOCUMENTS_API_SCOPES.write) },
    async (request, reply) => {
      const { id } = request.params;
      // An ID that cannot be a row is the same answer as one the caller may not see (§6.5: no existence leak).
      if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' });
      const workspace = await service.ensurePersonalProject(userOf(request), id);
      return toPersonalWorkspaceWire(workspace);
    },
  );

  return app;
}

/** The status of an error Fastify raised about the request itself (4xx), undefined for anything else. */
function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

function isValidationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'validation' in error &&
    (error as { validation?: unknown }).validation !== undefined
  );
}
