/**
 * `@auth-stack/auth/fastify`: the bearer verification and the scope gate as a Fastify plugin (docs/README.md
 * §6.7, §9), plus the server options every API shares (request IDs, log redaction) and the security headers of
 * §9 on every response (`apiSecurityHeaders`). Deny by default: once the
 * plugin is registered, every route needs a valid bearer token unless it says `config: { public: true }` (the
 * health endpoint); `fastify.requireScope(...)` adds the scope check to a route. Failures answer per RFC 6750
 * §3: `401` with `WWW-Authenticate: Bearer` or `Bearer error="invalid_token"`, `403` with
 * `error="insufficient_scope"`; the body never says which check failed, the log does.
 */
import { randomUUID } from 'node:crypto';

import { LogController } from 'fastify';
import fp from 'fastify-plugin';

import {
  assertScopeStrings,
  BearerError,
  requireScopes,
  type BearerVerifier,
  type Principal,
  type ScopeResolver,
} from '../bearer';
import { API_SECURITY_HEADERS } from '../headers';

import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
  preHandlerAsyncHookHandler,
  RawServerDefault,
} from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified caller; set by the plugin's `onRequest` hook, absent on public routes. */
    principal: Principal | undefined;
  }
  interface FastifyInstance {
    /** A `preHandler` hook requiring every named scope of the token's client (§6.7). */
    requireScope(...scopes: string[]): preHandlerAsyncHookHandler;
  }
  interface FastifyContextConfig {
    /** No bearer token needed (the health endpoint). Everything else is denied without one. */
    public?: boolean;
  }
}

export interface BearerPluginOptions {
  verifier: BearerVerifier;
  scopes: ScopeResolver;
}

function deny(request: FastifyRequest, reply: FastifyReply, bearer: BearerError): FastifyReply {
  request.log.warn(
    { code: bearer.code, reason: bearer.message, scopes: bearer.scopes },
    'auth.bearer_rejected',
  );
  return reply
    .code(bearer.status)
    .header('www-authenticate', bearer.challenge)
    .send({ error: bearer.code });
}

export const bearerPlugin = fp<BearerPluginOptions>(
  (fastify, options) => {
    const { verifier, scopes } = options;
    fastify.decorateRequest('principal', undefined);

    fastify.addHook('onRequest', async (request, reply) => {
      if (request.routeOptions.config.public) return;
      try {
        request.principal = await verifier.verify(request.headers.authorization);
      } catch (error) {
        // Anything but a verdict on the token (the JWKS unreachable) is a server error, not a 401.
        if (error instanceof BearerError) return deny(request, reply, error);
        throw error;
      }
    });

    fastify.decorate('requireScope', (...required: string[]): preHandlerAsyncHookHandler => {
      assertScopeStrings(required);
      return async (request, reply) => {
        try {
          if (!request.principal)
            throw new BearerError('missing_token', 'no principal on the request');
          await requireScopes(request.principal, scopes, required);
        } catch (error) {
          // A resolver that cannot answer (SpiceDB down) is a server error, never `invalid_token`.
          if (error instanceof BearerError) return deny(request, reply, error);
          throw error;
        }
      };
    });

    return Promise.resolve();
  },
  { name: '@auth-stack/auth/fastify', fastify: '5.x' },
);

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Headers that never reach a log line, whatever the level. */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'res.headers["www-authenticate"]',
];

export interface ApiServerOptions {
  /** Pino level; `info` by default. */
  logLevel?: string;
  /** A logger instance instead of Fastify's own (tests pass a silent one). */
  logger?: FastifyBaseLogger;
}

/**
 * The Fastify options shared by the APIs: a request ID taken from an inbound `X-Request-Id` when it is one
 * (so a BFF's ID follows the request into the API's logs) and generated otherwise, logged as `requestId`,
 * and redaction of the credential-bearing headers (§9: no tokens in logs).
 */
export function apiServerOptions(
  options: ApiServerOptions = {},
): FastifyServerOptions<RawServerDefault> {
  return {
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (request) => {
      const inbound = request.headers['x-request-id'];
      return typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
    ...(options.logger
      ? { loggerInstance: options.logger }
      : {
          logger: {
            level: options.logLevel ?? 'info',
            redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
          },
        }),
  };
}

/** Echoes the request ID on every response, so a client can quote it. Register once per server. */
export function echoRequestId(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
}

/** The security headers of §9 on every response, errors and the health endpoint included. Register once per server. */
export function apiSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) reply.header(name, value);
  });
}
