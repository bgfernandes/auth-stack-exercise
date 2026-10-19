/**
 * Every failure of the package is an `AuthError` with a code the host can branch on. A login route maps all of
 * the login codes to one generic "login failed" page (docs/README.md §4.4): which check failed is logged with
 * `redact`, never shown to the browser.
 */
export type AuthErrorCode =
  /** The callback arrived without a login stash cookie, or the stash did not verify. */
  | 'no_login_in_progress'
  /** The stash is older than its lifetime (10 minutes). */
  | 'login_expired'
  /** The `state` on the callback is not the one of the stash. */
  | 'state_mismatch'
  /** The ID token's `nonce` is not the one of the stash. */
  | 'nonce_mismatch'
  /** The authorization server answered the callback with an error (`access_denied`, ...). */
  | 'authorization_denied'
  /** The token endpoint refused the code exchange. */
  | 'exchange_failed'
  /** The token response or the ID token failed validation (`iss`, `aud`, `exp`, signature, missing claims). */
  | 'token_invalid'
  /** The refresh token was refused or the refresh response failed validation. */
  | 'refresh_failed'
  /** A state-changing request did not come from the app's own origin (`assertSameOrigin`). */
  | 'forbidden_origin'
  /** A form post carried no synchronizer token, or one that is not the session's (`verifyCsrfToken`). */
  | 'csrf_token_invalid'
  /** A binding's `onLogin` hook (just-in-time provisioning) threw; the new session was removed again. */
  | 'login_hook_failed'
  /** A back-channel logout request carried no logout token, or the token failed validation (§4.4 step 6). */
  | 'logout_token_invalid';

export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(
    readonly code: AuthErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
