/**
 * `tenancy-api` (docs/README.md §3.1, §6.4, §6.6): the tenancy service behind bearer tokens. Every route but
 * the health endpoint needs a verified token of the project (the plugin of `@auth-stack/auth/fastify`, deny by
 * default) and the scope its row of §6.7 names; the handlers then act for the token's `sub` and let the service
 * ask SpiceDB. The wire format is the snake_case JSON of `@auth-stack/tenancy/client`, which the HTTP client
 * parses, and an error body is `{ error: <code> }` and nothing else: the reason goes to the log.
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
import { fullyConsistent } from '@auth-stack/authz';
import {
  membershipWire,
  parsePolicy,
  TENANCY_API_SCOPES,
  TenancyError,
  toMemberWire,
  toSummary,
  toWire,
  type TenancyErrorCode,
  type TenancyService,
} from '@auth-stack/tenancy';

import { UserinfoError, type UserinfoClient } from './userinfo';

export interface AppDeps {
  service: TenancyService;
  verifier: BearerVerifier;
  scopes: ScopeResolver;
  userinfo: UserinfoClient;
  /** A logger instance instead of Fastify's own (tests pass a silent one). */
  logger?: FastifyBaseLogger;
  logLevel?: string;
}

const STATUS_OF: Record<TenancyErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  personal_organization: 409,
  not_a_member: 400,
  last_admin: 409,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER = /^Bearer\s+(\S+)$/i;

/** The verified caller; the plugin set it before any handler below ran. */
function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw new Error('no principal on a protected route');
  return request.principal;
}

/** The token as presented, for forwarding to userinfo; the plugin already verified it. */
function rawToken(request: FastifyRequest): string {
  const match = BEARER.exec(request.headers.authorization?.trim() ?? '');
  if (!match?.[1]) throw new Error('no bearer token on a protected route');
  return match[1];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { service, userinfo } = deps;
  const app = Fastify(
    apiServerOptions(
      deps.logger ? { logger: deps.logger } : deps.logLevel ? { logLevel: deps.logLevel } : {},
    ),
  );
  echoRequestId(app);
  await app.register(bearerPlugin, { verifier: deps.verifier, scopes: deps.scopes });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof TenancyError) {
      return reply.code(STATUS_OF[error.code]).send({ error: error.code });
    }
    if (error instanceof BearerError) {
      return reply
        .code(error.status)
        .header('www-authenticate', error.challenge)
        .send({ error: error.code });
    }
    if (error instanceof UserinfoError) {
      request.log.warn({ kind: error.kind, reason: error.message }, 'auth.userinfo_failed');
      if (error.kind === 'rejected') {
        const bearer = new BearerError('invalid_token', error.message);
        return reply
          .code(bearer.status)
          .header('www-authenticate', bearer.challenge)
          .send({ error: bearer.code });
      }
      return reply.code(502).send({ error: 'userinfo_unavailable' });
    }
    // A body outside the wire format (the route's schema) or outside the policy's rules (the service's).
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

  // §6.4: idempotent. `sub` from the token; email and name from userinfo on the first call for that `sub` only.
  app.post(
    '/me/provision',
    { preHandler: app.requireScope(TENANCY_API_SCOPES.write) },
    async (request) => {
      const { sub } = principalOf(request);
      const existing = await service.getUser(sub);
      const claims = existing
        ? { sub, email: existing.email, name: existing.displayName }
        : await userinfo.claims(rawToken(request));
      if (claims.sub !== sub) throw new Error('userinfo answered for another subject');
      const outcome = await service.provisionUser(claims);
      return { organization: toWire(toSummary(outcome.organization)), created: outcome.created };
    },
  );

  app.get(
    '/me/organizations',
    { preHandler: app.requireScope(TENANCY_API_SCOPES.read) },
    async (request) => {
      const { sub } = principalOf(request);
      // Phase 1 reads at full consistency (ticket 21 revisits the listing levels).
      const organizations = await service.listOrganizations({ sub }, fullyConsistent);
      return {
        organizations: organizations.map((organization) => toWire(toSummary(organization))),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/organizations/:id',
    { preHandler: app.requireScope(TENANCY_API_SCOPES.read) },
    async (request, reply) => {
      const { sub } = principalOf(request);
      const { id } = request.params;
      // An ID that cannot be a row is the same answer as one the caller may not see (§6.5: no existence leak).
      const organization = UUID.test(id)
        ? await service.getOrganization({ sub }, id, fullyConsistent)
        : undefined;
      if (!organization) return reply.code(404).send({ error: 'not_found' });
      return toWire(toSummary(organization));
    },
  );

  // §6.8: the member list is what every member sees and what the share picker offers; a non-member gets 404.
  app.get<{ Params: { id: string } }>(
    '/organizations/:id/members',
    { preHandler: app.requireScope(TENANCY_API_SCOPES.read) },
    async (request, reply) => {
      const { sub } = principalOf(request);
      const { id } = request.params;
      const members = UUID.test(id)
        ? await service.listMembers({ sub }, id, fullyConsistent)
        : undefined;
      if (!members) return reply.code(404).send({ error: 'not_found' });
      return { members: members.map(toMemberWire) };
    },
  );

  // One current member's role, or null to remove them (ticket 17); the service holds the rules (§6.8), and a
  // malformed ID is the same 404 as an organization the caller may not see.
  app.put<{ Params: { id: string } }>(
    '/organizations/:id/members',
    { preHandler: app.requireScope(TENANCY_API_SCOPES.write) },
    async (request, reply) => {
      const { sub } = principalOf(request);
      const { id } = request.params;
      const change = membershipWire.parse(request.body);
      if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' });
      await service.setMembership({ sub }, id, change.member_id, change.role);
      return reply.code(204).send();
    },
  );

  // The authentication-context floors of §9.1, replaced whole; the service validates them (`ZodError` → 400).
  app.put<{ Params: { id: string } }>(
    '/organizations/:id/policy',
    { preHandler: app.requireScope(TENANCY_API_SCOPES.write) },
    async (request, reply) => {
      const { sub } = principalOf(request);
      const { id } = request.params;
      const policy = parsePolicy(request.body);
      if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' });
      return toWire(toSummary(await service.setPolicy({ sub }, id, policy)));
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
