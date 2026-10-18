/**
 * The IdP's userinfo endpoint (OpenID Connect Core §5.3), asked with the caller's own access token for the email
 * and name of a user the platform has never seen (docs/README.md §6.4): verified by the IdP, never trusted from
 * the request body. The token is forwarded and never logged.
 */
import { type ProvisionClaims } from '@auth-stack/tenancy';

export type UserinfoErrorKind =
  /** The IdP refused the token (401): the caller's token is not good for userinfo, so not good at all. */
  | 'rejected'
  /** The IdP could not be reached or answered with an error: the caller is not at fault. */
  | 'unavailable'
  /** The IdP answered without an email or a name, which the mirror row needs. */
  | 'incomplete';

export class UserinfoError extends Error {
  override readonly name = 'UserinfoError';

  constructor(
    readonly kind: UserinfoErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

export interface UserinfoClient {
  /** The claims provisioning needs, from the userinfo endpoint; throws `UserinfoError`. */
  claims(accessToken: string): Promise<ProvisionClaims>;
}

export interface UserinfoClientOptions {
  /** The `userinfo_endpoint` of the issuer's discovery document; bootstrap writes it to `apis.env`. */
  url: string;
  fetch?: typeof fetch;
}

interface UserinfoResponse {
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  preferred_username?: unknown;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export function createUserinfoClient(options: UserinfoClientOptions): UserinfoClient {
  const doFetch = options.fetch ?? fetch;
  return {
    async claims(accessToken) {
      let response: Response;
      try {
        response = await doFetch(options.url, {
          headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        });
      } catch (error) {
        throw new UserinfoError('unavailable', 'userinfo request failed', { cause: error });
      }
      if (response.status === 401)
        throw new UserinfoError('rejected', 'userinfo refused the token');
      if (!response.ok)
        throw new UserinfoError('unavailable', `userinfo answered ${response.status}`);
      const body = (await response.json()) as UserinfoResponse;
      const sub = text(body.sub);
      const email = text(body.email);
      const name =
        text(body.name) ??
        text([text(body.given_name), text(body.family_name)].filter(Boolean).join(' ')) ??
        text(body.preferred_username);
      if (!sub || !email || !name) {
        throw new UserinfoError('incomplete', 'userinfo answered without sub, email, or name');
      }
      return { sub, email, name };
    },
  };
}
