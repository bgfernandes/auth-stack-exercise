# SSO with OAuth 2.0 and OpenID Connect

## About this copy

This checklist was written by the repository's maintainer before this project, in August 2026, as the output of a self-study of single sign-on across first-party applications with OAuth 2.0 and OpenID Connect, done in conversation with an AI assistant. It is reproduced below without changes to its wording or numbering, since the review described at the end of this preamble cites its items by number.

The study worked through one scenario: a company with one identity provider and several first-party applications of different shapes (a hybrid server-rendered web app, a single-page app with its own REST API, and a plugin running inside a third-party application that calls that API). It asked how each one authenticates, how sessions are managed across them, how single sign-out propagates and stays scoped to one device, how step-up and recent re-authentication are requested and verified, which shapes of session storage support logout, and how an application notices that the identity provider's session has ended. The checklist is the recap of that study, organized by lifecycle phase from client registration to expiry, with a one-line reason attached to each rule and a closing list of behaviours that vary by identity provider and change the design.

It is a working document, not a standard. It rests on the RFCs and OpenID Connect specifications listed in its reference table, and the maintainer's instruction to themselves is to re-derive from those specifications where it matters rather than treat the checklist as authoritative. Several of its positions were revised during the study itself: requirements first stated as absolute turned out to be one implementation choice among several (which server-side state back-channel logout needs, and whether sessions can stay in stateless cookies), the scope of one failure mode was widened (a rotated `sid` orphans every application outside the redirect path, not only the one that stepped up), and the component that owns out-of-band revocation was corrected (the identity provider, never the application). The checklist carries the final positions only.

This repository uses it as a review yardstick. On 2026-10-19 an independent review agent reviewed `packages/auth` against it; what was fixed on the spot and what was recorded instead is in the decision log of `docs/README.md` (the 2026-10-19 entry on the reviews). The items the design deliberately decided against or deferred are recorded there and in `docs/TICKETS.md`, under the ticket that carries each one: the BFFs' client authentication method (4a), re-reading session claims after a token refresh (8a), a refresh lock across instances (8b), re-validation of the identity-provider session as the backstop for a missed logout token (20a), and "log out everywhere" (20b). Where the stack's identity provider cannot satisfy an item, such as authentication-context claims in access tokens, the trade-off is stated in `docs/README.md` and in the root README's trade-offs section rather than skipped silently.

---

**Implementation checklist for first-party applications.** Covers step-up MFA, re-authentication, and access tokens for internal APIs.

Ordered by lifecycle phase, since that's the order you build in. Each rule carries a one-line reason — a rule without its reason gets cargo-culted or dropped at the first inconvenience.

---

## 1. Client registration

- **One `client_id` per app** — shared clients make `aud` validation meaningless and prevent per-app revocation.
- **Exact-match redirect URIs** — prefix or wildcard matching is an open redirect waiting to be found.
- **Confidential client wherever a server exists** — a secret plus PKCE is strictly stronger than PKCE alone.
- **`backchannel_logout_uri` + `backchannel_logout_session_required: true`** — without the flag you get `sub`-only logout tokens and lose all device scoping.
- **Public subject type** — pairwise subjects give each app a different `sub` for the same human, breaking cross-app correlation.
- **IdP on the same registrable domain as the apps** — keeps iframe-based silent flows same-site and immune to cookie partitioning.

## 2. Authorization request

- **Auth code + PKCE (`S256`) always** — PKCE binds the code to the client that requested it, even for confidential clients.
- **`state` and `nonce`, stored server-side or in a transient cookie** — `state` stops CSRF on the callback, `nonce` stops ID token replay.
- **`SameSite=None; Secure` on that transient cookie if using `form_post`** — the response is a cross-site POST and `Lax` cookies won't be sent.
- **`resource` naming the target API (RFC 8707)** — stops a token minted for one service being spent at another.
- **`acr_values` / `max_age` when the app has a baseline requirement** — expressing it at login avoids a step-up interrupt on the first sensitive action.

## 3. Callback validation

- **Signature against cached JWKS** — an unverified JWT is a user-supplied string.
- **`iss` exact match, `aud` = your `client_id`** — this is the check that prevents token substitution from another client.
- **`exp` / `iat` / `nbf` with ~60s skew** — bounds the replay window without breaking on clock drift.
- **`nonce` and `state` match what you stored** — ties the response to a request you actually initiated.
- **Verify returned `acr` if you sent `acr_values`; verify `auth_time` if you sent `max_age`** — both are requests, not guarantees, and a silent downgrade is invisible otherwise.

## 4. Session storage — two valid shapes

Both support device-scoped and global logout. Pick on payload size.

| | Session store | Logout-event log |
| --- | --- | --- |
| Cookie | Opaque ID | `sub`, `sid`, `auth_time`, `iat`, tokens (encrypted) |
| Store holds | One row per active session | One marker per logout event |
| Logout action | Delete matching rows | Write a marker |
| Fits access + refresh tokens | Yes | Often exceeds the 4KB cookie budget |
| Growth | With active users | With logout events (bounded by TTL) |

- **Apps holding tokens for a backend API → session store** — access plus refresh tokens plus JWE overhead will blow the cookie limit, and chunking is miserable.
- **Identity-only apps → event log is simpler** — no session table to operate, and markers self-expire.
- **`sid` markers are existence checks, no timestamp** — a destroyed IdP session can never be resurrected, and comparison would wrongly spare a session created from an in-flight login carrying the dead `sid`.
- **`sub` markers are comparative, and overwrite rather than append** — "log out everywhere at T" must not kill a session created after T, and only the latest event per user matters.
- **Compare IdP-issued values: logout token `iat` vs. ID token `auth_time`** — comparing your own nodes' clocks produces undebuggable spurious logouts.
- **`sid` marker TTL = your longest absolute session cap** — past that point the cap check kills the session independently, so the marker is dead weight.
- **Whichever shape: `HttpOnly; Secure; SameSite=Lax`, `__Host-` prefix where possible** — keeps the cookie out of JavaScript and off other origins.
- **Re-read `sid`, `auth_time`, and `acr` from every ID token, including refresh-grant and step-up ones** — these are mutable, and a stale `sid` silently orphans the app from logout propagation.

## 5. Every request

- **Load session → absolute cap check → logout check → proceed** — three cheap checks that together make logout eventually consistent.
- **Re-check in the route handler or server component, not only middleware** — CVE-2025-29927 showed middleware-only protection in Next.js is bypassable via header spoofing.
- **Refresh behind a per-session mutex** — parallel server-side fetches otherwise fire concurrent refreshes and trip rotation reuse detection.
- **Never exempt endpoints from the logout check** — the exemption list is where the sensitive endpoint eventually gets added.

## 6. Calling a backend API

- **Bearer access token, never the ID token** — wrong audience, no scopes, and it leaks PII to a service that shouldn't hold it.
- **API validates signature, `iss`, `aud` = its own identifier, `exp`, `scope`** — `aud` is what stops cross-service token replay.
- **Sensitive endpoints also validate `acr` and `auth_time`** — the API can't read your session, so the token must carry the evidence.
- **Confirm your IdP emits `acr`/`amr`/`auth_time` in access tokens** — RFC 9068 permits it but many IdPs omit it by default, and discovering this late invalidates your step-up design.

## 7. Step-up and MFA

- **Enforce at the resource server via RFC 9470 `insufficient_user_authentication`** — policy lives with the resource, so new sensitive endpoints don't need a coordinated client release.
- **Prefer `max_age` over `prompt=login`** — `auth_time` gives verifiable evidence, and it's less likely to trigger session recreation.
- **Use the `claims` parameter with `acr` `essential: true` when the level is mandatory** — plain `acr_values` is voluntary and can be downgraded silently.
- **Stash pending state keyed to `state` before redirecting** — a step-up is a full navigation and will otherwise destroy the user's work.
- **Distinct ACR values per tier; gate on `acr` not `auth_time`** — `auth_time` is shared across the SSO session, so a low-stakes step-up would satisfy a high-stakes check.
- **Consider CIBA for constrained clients** — pushing approval to a phone avoids a disruptive browser handoff mid-task.

## 8. Logout

- **POST with CSRF protection, then a top-level redirect to `end_session_endpoint`** — `fetch` returns 200 and clears nothing, because the IdP needs a navigation to touch its own cookie.
- **Revoke the refresh token (RFC 7009) before redirecting** — closes the window where your backend could refresh mid-logout.
- **Validate the logout token: signature, `iss`, `aud`, `events`, and no `nonce`** — the absent `nonce` is what distinguishes it from a replayed ID token.
- **Return `200` and make the handler idempotent** — the spec requires it and retries are likely.
- **`sid` present → that session; `sub` only → all sessions** — this is the entire device-scoping mechanism.
- **Unknown `sid` with known `sub` → fail closed** — over-logging-out is annoying, ignoring a logout token is a security hole.
- **Out-of-band admin revocation goes through the IdP, not the app** — only the IdP knows all of a user's sessions, and app-local deletion is theatre since SSO re-authenticates on next navigation.
- **"Log out everywhere" is a separate deliberate feature** — pair it with an active-sessions screen users can act on.

## 9. Expiry and liveness

- **Absolute cap from `auth_time + MAX_SESSION_AGE`** — bounds session lifetime with no IdP state to mirror, and it's what makes logout markers expirable.
- **Optional `prompt=none` heartbeat via same-site iframe** — agnostic to *why* the IdP session ended, so it catches expiry, revocation, and missed logout tokens alike.
- **Treat the heartbeat interval as a security parameter** — a tight poll silently disables IdP idle timeout across the whole estate.
- **Don't use refresh-token failure as a liveness signal** — many IdPs decouple refresh lifetime from SSO session lifetime, so success proves nothing.

## 10. Things that vary by IdP and change your design

These are not implementation steps; they are constraints to establish before designing, because each one has a different architecture on either side of the answer.

- **Does discovery advertise `backchannel_logout_supported` and `backchannel_logout_session_supported`?** — the second determines whether device-scoped logout is possible at all.
- **Are `acr`/`amr`/`auth_time` available in access tokens?** — determines whether step-up can be enforced at the API rather than the client.
- **Does re-authentication rotate `sid`, and does it emit logout for the old one?** — rotation without notification orphans every app not in the redirect path.
- **Are refresh token lifetimes coupled to the SSO session?** — determines whether session revocation actually ends API access.
- **Does back-channel logout fire on administrative revocation, not just user logout?** — a gap here is invisible in testing, because user logout works fine.
- **Is CIBA available?** — changes step-up design for any client that can't cleanly do a browser redirect.

---

## Reference

| Spec | What it covers |
| --- | --- |
| RFC 6749 / 6750 | OAuth 2.0 core, bearer tokens |
| RFC 7009 | Token revocation |
| RFC 7636 | PKCE |
| RFC 7662 | Token introspection |
| RFC 8252 | OAuth for native apps |
| RFC 8414 | Authorization server metadata |
| RFC 8628 | Device authorization grant |
| RFC 8707 | Resource indicators |
| RFC 9068 | JWT profile for access tokens |
| RFC 9126 | Pushed authorization requests (PAR) |
| RFC 9449 | DPoP — sender-constrained tokens |
| RFC 9470 | Step-up authentication challenge |
| RFC 9700 | OAuth 2.0 security best current practice |
| OIDC Core / Discovery | ID tokens, claims, `acr`, `auth_time`, `sid` |
| OIDC RP-Initiated Logout | `end_session_endpoint`, `id_token_hint` |
| OIDC Back-Channel Logout | Logout tokens, `sid` scoping |
| IETF browser-based apps BCP | BFF pattern, SPA token handling |

## The meta-point

That's fifty-odd rules and no app team will hold them. The distribution problem is the real one: build it once as shared infrastructure plus a behavioural contract, and let each app implement the small irreducible remainder. The complexity is inherent to federation — the goal isn't to remove it but to make exactly one team responsible for getting it right.
