/**
 * The app's authentication (docs/README.md §4.4; ticket 9): one `createNextAuth` of `@auth-stack/auth/next`
 * per process over the Redis session store, with the env contract of the package (`OIDC_*` and `APP_URL` from
 * bootstrap's handoff file, `SESSION_SECRET` and `REDIS_URL` from the compose service or the Tiltfile), and the
 * provisioning of `lib/provisioning.ts` as its login hook (ticket 10). It is built on first use, not when the
 * module loads: `next build` evaluates the route modules with no configuration, and a missing variable must
 * fail the first request, not the image build. Under `next dev` the instance lives on `globalThis`, so the
 * modules hot reloading re-evaluates share one Redis connection.
 */
import { Redis } from 'ioredis';

import { authOptionsFromEnv, createRedisSessionStore } from '@auth-stack/auth';
import { createNextAuth, type NextAuth } from '@auth-stack/auth/next';

import { clients } from './clients';
import { log } from './log';
import { createWorkspaceProvisioner } from './provisioning';

const APP = 'dashboard-web';

interface AppAuth {
  auth: NextAuth;
  /** The app's public URL (`APP_URL`), for redirects: never the host the server saw the request on. */
  appUrl: string;
}

function build(): AppAuth {
  const options = authOptionsFromEnv(process.env, { app: APP });
  const redis = new Redis(options.redisUrl);
  // ioredis reconnects on its own; without a listener it only prints the error, which this keeps in one format.
  redis.on('error', (error: Error) => {
    log.warn('redis.error', { message: error.message });
  });
  const store = createRedisSessionStore(redis, { prefix: APP });
  const onLogin = createWorkspaceProvisioner({ ...clients(), logger: log });
  return {
    auth: createNextAuth({ options, store, afterLoginPath: '/dashboard', onLogin, logger: log }),
    appUrl: options.appUrl,
  };
}

const cache = globalThis as typeof globalThis & { __dashboardWebAuth?: AppAuth };

function appAuth(): AppAuth {
  cache.__dashboardWebAuth ??= build();
  return cache.__dashboardWebAuth;
}

/** The route helpers and session readers bound to this app. */
export function auth(): NextAuth {
  return appAuth().auth;
}

/** An absolute URL under the app's public origin. */
export function appUrl(path: string): URL {
  return new URL(path, appAuth().appUrl);
}
