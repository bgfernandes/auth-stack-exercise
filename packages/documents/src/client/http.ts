/**
 * `DocumentsClient` over HTTP to `dashboard-api` (docs/README.md §6.5): every call carries the user's own access
 * token, the answers are parsed from the wire format of `./wire`, and an answer outside the contract is a
 * `DocumentsClientError` with the status and the API's error code, which the BFF maps to its pages. Nothing is
 * cached: every answer is a permission decision for one user at one moment, and the listing is what the user
 * reads right after a save.
 */
import {
  documentSharesWire,
  documentsWire,
  documentWire,
  fromDocumentWire,
  fromPersonalWorkspaceWire,
  fromVisibleDocumentWire,
  personalWorkspaceWire,
  type DocumentSharesWire,
  type DocumentValuesWire,
} from './wire';

import type {
  DocumentShares,
  DocumentSummary,
  PersonalWorkspaceSummary,
  VisibleDocument,
} from './index';
import type { UserContext } from '@auth-stack/tenancy/client';

/** The calls a BFF makes into the documents domain (§6.5), each on behalf of the user. */
export interface DocumentsClient {
  /**
   * Every document the user may view, with `canEdit` and `canShare` decided (the dashboard). The API picks the
   * consistency: the cached snapshot, or, with `freshAs`, at least as fresh as the token stored on that row, so
   * the user who just wrote the row reads their own write (§7.3); an ID that is no row is ignored.
   */
  listVisibleDocuments(
    user: UserContext,
    options?: { freshAs?: string },
  ): Promise<VisibleDocument[]>;
  /** The document's direct shares (§6.8), for a caller who may share it; `forbidden` (403) for an editor or viewer, `not_found` (404) otherwise. */
  getDocumentShares(user: UserContext, id: string): Promise<DocumentShares>;
  /** The row for the edit form; `forbidden` (403) when the user may only view it, `not_found` (404) otherwise. */
  getDocumentForEdit(user: UserContext, id: string): Promise<DocumentSummary>;
  /** The content write; the same refusals as the read, and `invalid_input` (400) for values the service refuses. */
  updateDocument(
    user: UserContext,
    id: string,
    values: { value1: string; value2: string },
  ): Promise<DocumentSummary>;
  /** Replaces the document's direct shares (§6.8); `not_a_member` (400) names a user outside the organization. */
  setDocumentShares(
    user: UserContext,
    id: string,
    shares: { editors: string[]; viewers: string[] },
  ): Promise<DocumentSummary>;
  /** Idempotent (§6.4): the "Personal" project and its "Welcome" document in the organization. */
  ensurePersonalProject(
    user: UserContext,
    organizationId: string,
  ): Promise<PersonalWorkspaceSummary>;
}

export interface HttpDocumentsClientOptions {
  /** `http://dashboard-api:4002` in compose, `http://localhost:4002` under Tilt (`DASHBOARD_API_URL`). */
  baseUrl: string;
  fetch?: typeof fetch;
}

/** An answer other than the ones the contract allows: the status and the API's error code. */
export class DocumentsClientError extends Error {
  override readonly name = 'DocumentsClientError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Whether an error is the client's refusal, by shape rather than by `instanceof`: a bundler that builds a
 * route handler and a server component as separate layers gives each its own copy of this module while the
 * client they share was built by one of them, so `instanceof` fails across that line (the tenancy client and
 * the service's own error have the same guard, for the same reason).
 */
export function isDocumentsClientError(error: unknown): error is DocumentsClientError {
  return (
    error instanceof Error &&
    error.name === 'DocumentsClientError' &&
    'status' in error &&
    typeof error.status === 'number' &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

export function createHttpDocumentsClient(options: HttpDocumentsClientOptions): DocumentsClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;

  async function call(
    user: UserContext,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
  ): Promise<unknown> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    // A body that is not JSON (a proxy's error page) is reported through the status, not as a parse error.
    const body: unknown = text ? parseJson(text) : undefined;
    if (response.status !== 200) {
      const code =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'http_error';
      throw new DocumentsClientError(
        response.status,
        code,
        `${method} ${path}: ${response.status} ${code}`,
      );
    }
    return body;
  }

  const documentPath = (id: string) => `/documents/${encodeURIComponent(id)}`;

  return {
    async listVisibleDocuments(user, options = {}) {
      const query = options.freshAs ? `?fresh_as=${encodeURIComponent(options.freshAs)}` : '';
      const body = await call(user, 'GET', `/documents${query}`);
      return documentsWire.parse(body).documents.map(fromVisibleDocumentWire);
    },

    async getDocumentForEdit(user, id) {
      return fromDocumentWire(documentWire.parse(await call(user, 'GET', documentPath(id))));
    },

    async updateDocument(user, id, values) {
      const payload: DocumentValuesWire = { value_1: values.value1, value_2: values.value2 };
      return fromDocumentWire(
        documentWire.parse(await call(user, 'PUT', documentPath(id), payload)),
      );
    },

    async getDocumentShares(user, id) {
      const wire = documentSharesWire.parse(await call(user, 'GET', `${documentPath(id)}/shares`));
      return { editors: wire.editors, viewers: wire.viewers };
    },

    async setDocumentShares(user, id, shares) {
      const payload: DocumentSharesWire = { editors: shares.editors, viewers: shares.viewers };
      return fromDocumentWire(
        documentWire.parse(await call(user, 'PUT', `${documentPath(id)}/shares`, payload)),
      );
    },

    async ensurePersonalProject(user, organizationId) {
      const body = await call(
        user,
        'POST',
        `/organizations/${encodeURIComponent(organizationId)}/personal-project`,
      );
      return fromPersonalWorkspaceWire(personalWorkspaceWire.parse(body));
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The client of `DASHBOARD_API_URL`, the value bootstrap writes to each BFF's env file. */
export function httpDocumentsClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<HttpDocumentsClientOptions, 'baseUrl'> = {},
): DocumentsClient {
  const baseUrl = env.DASHBOARD_API_URL;
  if (!baseUrl) throw new Error('missing environment variable DASHBOARD_API_URL');
  return createHttpDocumentsClient({ baseUrl, ...options });
}
