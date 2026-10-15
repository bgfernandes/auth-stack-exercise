# Auth Stack Exercise — Tickets

> **📜 Decision log.** Per-ticket planning and decision record. Statuses and decisions are dated snapshots: corrections are appended as dated notes (`> **YYYY-MM-DD:** ...`) that win over earlier text, never silently rewritten.

> Each ticket is one PR unless marked **🔬 spike** (investigation; may produce no code) or **📝 docs** (documentation only).
>
> **Every code ticket must:**
>
> - Open the PR description with `Read first: docs/README.md` and name the ticket.
> - Pass `pnpm lint`, `pnpm type-check`, and `pnpm test` before "done".
> - Use conventional commits; one PR per ticket, merged with a merge commit (no squash); branch named `<ticket>-<slug>` (`04-bootstrap`, `17a-invitations`).
> - Update its **Status** line here in the same PR.
>
> Tickets are listed in implementation order; ticket numbers are stable identifiers, not the order (tickets 15 and 16 moved into phase 1 on 2026-10-15 and kept their numbers). Phases 0–2 are fully specified; later phases are stubs that get specified with a dated note when the phase starts. Estimates are working hours including review.

---

## Phase 0 — Foundation

### Ticket 0 — Commit the architecture doc, this ticket list, and `CLAUDE.md` 📝 docs

**Description:** `docs/README.md`, `docs/TICKETS.md`, and `CLAUDE.md` are the shared context for every PR. Commit them on `main` directly (the only direct commit).

**Acceptance criteria:** the three files exist on `main`; the root `README.md` has a one-paragraph description and a pointer to `docs/README.md` (the full README is ticket 14).

**Status:** In progress (2026-10-13).

---

### Ticket 1 — Monorepo scaffold (1.5 h)

**Read first:** `docs/README.md` §3.1, `CLAUDE.md` (stack decisions).

**Description:** Create the pnpm workspace with the shared tooling every later ticket relies on.

- `pnpm-workspace.yaml` with `apps/*` and `packages/*`; root `package.json` (already present with `lint:md`) with `packageManager` pinned to the current pnpm 10.x and scripts `lint` (ESLint plus `lint:md`), `type-check`, `test` (unit only, no infrastructure), `test:integration` (needs the compose stack; see ticket 5), `test:e2e`, `format`. Naming: packages are scoped `@auth-stack/<name>` (`@auth-stack/auth`, `@auth-stack/authz`, `@auth-stack/db-core`, `@auth-stack/config`, `@auth-stack/tenancy`, `@auth-stack/documents`); apps are unscoped (`dashboard-web`, `tenancy-api`, `bootstrap`), which is what `pnpm --filter <app>` uses.
- `mise.toml` pinning Node 22 (LTS; Next.js 16 needs ≥ 20.9) and pnpm.
- `tsconfig.base.json` (strict, `NodeNext` modules, `noUncheckedIndexedAccess`) for packages and Fastify apps; Next.js apps extend it with `moduleResolution: bundler` as Next requires. `packages/config` holds the shared tsconfig and ESLint presets.
- Root ESLint flat config (`eslint.config.mjs`) with `typescript-eslint`, `eslint-config-next` for the web app, import ordering; Prettier; `.editorconfig`.
- Jest at the root with `@swc/jest`; two Jest projects, `unit` (default) and `integration` (files matching `*.integration.test.ts`, run only by `test:integration`); one placeholder unit test per package so the pipeline is green from the start.
- `.gitignore`, `.dockerignore`, `.nvmrc` mirror of the mise pin for tools that read it.
- Empty package skeletons: `packages/auth`, `packages/authz`, `packages/db-core`, `packages/tenancy`, `packages/documents`, `packages/config`, each with `package.json`, `tsconfig.json`, `src/index.ts`. `.markdownlint-cli2.yaml` and the `lint:md` scripts from ticket 0 are kept and folded into `lint`.

**Acceptance criteria:** `pnpm install`, `pnpm lint`, `pnpm type-check`, `pnpm test` all pass on a clean clone; `pnpm -r exec tsc --noEmit` resolves cross-package imports through workspace links.

**Status:** Open.

---

### Ticket 2 — Compose infrastructure: Postgres, Zitadel, Traefik, SpiceDB, Redis, Mailpit (2.5 h)

**Read first:** `docs/README.md` §4.2, §4.3.

**Description:** Bring up every third-party service with health checks and pinned images, starting from Zitadel's v4 reference compose (`deploy/compose/docker-compose.yml` in the Zitadel repository) trimmed to what this project needs.

- One `postgres:17-alpine` (admin `postgres`/`postgres`) with an init script creating the databases `zitadel`, `spicedb`, `tenancy`, `documents` (`comments` is added in phase 5), each owned by a same-named role with password equal to the role name; published on host port `5432` for Tilt; health check with `pg_isready`.
- `zitadel-api` (`ghcr.io/zitadel/zitadel:v4.19.4`) with `start-from-init --masterkey "${ZITADEL_MASTERKEY}"` (dev value `MasterkeyNeedsToHave32Characters`, exactly 32 characters), `ZITADEL_EXTERNALDOMAIN=${ZITADEL_DOMAIN}` / `ZITADEL_EXTERNALPORT=8080` / `ZITADEL_EXTERNALSECURE=false` (the `.env` variable is `ZITADEL_DOMAIN`, mapped onto `ZITADEL_EXTERNALDOMAIN` as in Zitadel's reference compose), `ZITADEL_TLS_ENABLED=false`, Login V2 settings, first-instance admin (`ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=zitadel-admin`, `..._PASSWORD=Password1!`, `..._PASSWORDCHANGEREQUIRED=false`), the login-client PAT path (`/bootstrap/login-client.pat`), a **bootstrap machine user** with the `IAM_OWNER` rights Zitadel grants to the first-instance machine user (`ZITADEL_FIRSTINSTANCE_PATPATH=/bootstrap/bootstrap.pat`, `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=bootstrap`, `..._MACHINE_NAME=Bootstrap`, `..._PAT_EXPIRATIONDATE=2099-01-01T00:00:00Z`), OIDC lifetimes (`ZITADEL_DEFAULTINSTANCE_OIDCSETTINGS_ACCESSTOKENLIFETIME=10m`, `..._IDTOKENLIFETIME=10m`, `..._REFRESHTOKENIDLEEXPIRATION=8h`, `..._REFRESHTOKENEXPIRATION=8h`; the exact key names to confirm against `defaults.yaml` in the spike), `ZITADEL_DEFAULTINSTANCE_LOGINPOLICY_IGNOREUNKNOWNUSERNAMES=true` (§9), `ZITADEL_DEFAULTINSTANCE_LOGINPOLICY_ALLOWREGISTER=true`; SMTP pointed at Mailpit (`ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_HOST=mailpit:1025`, `..._TLS=false`, `..._FROM=noreply@auth.localtest.me`, `..._FROMNAME`, `ZITADEL_DEFAULTINSTANCE_DOMAINPOLICY_SMTPSENDERADDRESSMATCHESINSTANCEDOMAIN=false`). Two shared locations: the named volume `zitadel-bootstrap`, mounted at `/bootstrap` in `zitadel-api` (rw), `zitadel-login` (ro), and `bootstrap` (ro), holding the two PATs and never mounted in an app; and a bind mount of `./.local/config/` (gitignored) at `/config` in `bootstrap` (rw) and every app (ro), holding the generated env files (ticket 4), which a Tilt-run process on the host reads from the same directory.
- `zitadel-login` (`ghcr.io/zitadel/zitadel-login:v4.19.4`) with `ZITADEL_API_URL=http://zitadel-api:8080`, `NEXT_PUBLIC_BASE_PATH=/ui/v2/login`, `ZITADEL_SERVICE_USER_TOKEN_FILE=/bootstrap/login-client.pat`, `ZITADEL_SESSION_COOKIE_SECRET` (dev value `SessionCookieSecretNeedsAtLeast32Chars`), `CUSTOM_REQUEST_HEADERS=Host:${ZITADEL_DOMAIN},X-Forwarded-Proto:http`.
- `proxy` (Traefik v3) with the reference routing labels, published on `8080`.
- `spicedb-migrate` (`authzed/spicedb:v1.56.2`, `migrate head`) and `spicedb` (`serve --grpc-preshared-key "${SPICEDB_PRESHARED_KEY}"` with dev value `dev-preshared-key`, `--datastore-engine postgres --datastore-conn-uri ...`), gRPC on `50051` published to the host for Tilt; health check with the `grpc_health_probe` binary bundled in the image. `zed` is not in the SpiceDB image; use the `authzed/zed` image through a `pnpm authz:zed` wrapper.
- `redis` (`redis:7-alpine`) with `--appendonly yes` so sessions survive a restart; published on host port `6379` for Tilt; health check with `redis-cli ping`.
- `mailpit` (`axllent/mailpit:v1.31.5`), SMTP `1025`, UI published on `8025`.
- A **committed `.env`** with the insecure development defaults above, every variable commented and the file headed with the warning that it is for local use only; no `.env.example` and no setup step, so `docker compose up` works on a clean clone without Node installed (§9 trade-off).
- `docs/README.md` §4.3 option (a) wired as the default: `ZITADEL_DOMAIN=auth.localtest.me`, `ZITADEL_EXTERNALPORT=8080`, app services get `extra_hosts: ["auth.localtest.me:host-gateway"]`. The spike (ticket 3) confirms or changes it. App hostnames follow the same scheme so that each BFF has its own cookie origin (browsers ignore ports for cookies): `dashboard.localtest.me:3000`, later `tenancy.localtest.me:3001` and `comments.localtest.me:3002`; APIs on `4001` (`tenancy-api`), `4002` (`dashboard-api`), `4003` (`comments-api`), reached by service name inside compose.

**Files:** `docker-compose.yml`, `docker/postgres/init.sql`, `.env.example`, `docker/README.md` (what each service is for).

**Acceptance criteria:** `docker compose up -d --wait` reaches healthy on every service from a clean state in under three minutes on a laptop; `http://auth.localtest.me:8080` shows Zitadel's login; `http://localhost:8025` shows Mailpit; `grpcurl` (or the `authzed/zed` image) can reach SpiceDB with the preshared key; `docker compose down -v && docker compose up -d --wait` works twice in a row.

**Tests:** `docker compose config` validates in CI (ticket 5).

**Status:** Open.

---

### Ticket 3 — Zitadel spike: one real login from a Next.js page inside compose 🔬 spike (3 h, timeboxed)

**Read first:** `docs/README.md` §4.2–4.4.

**Description:** Prove the riskiest assumption before anything depends on it: that a containerized Next.js app can complete an authorization-code + PKCE login against the containerized Zitadel, with a single issuer string that the browser and the container both use.

- Create a throwaway OIDC application in Zitadel's console (bootstrap automates this in ticket 4): type Web, PKCE, redirect `http://localhost:3000/auth/callback`, post-logout `http://localhost:3000/`.
- A bare `apps/dashboard-web` (Next.js 16, App Router) with `/auth/login` and `/auth/callback` route handlers using `openid-client` v6 (`discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`), printing the ID-token claims on a page. No session yet. The spike commits the first `Dockerfile` (multi-stage, `output: 'standalone'`), the compose service (profile `apps`), and the entrypoint that sources `/config/dashboard-web.env`; ticket 9 refines them rather than creating them.
- Run it inside compose with option (a) from §4.3. If discovery or the redirect fails on the issuer mismatch, try option (b) (custom fetch with a `Host` override) and option (c) (a trusted domain for the service name, checking what `issuer` discovery returns and what `iss` the tokens carry when reached through it). Record which one works and why as a dated note in `docs/README.md` §4.3.
- If `v4.19.4` misbehaves, retry with `v4.16.0` (the tag Zitadel's own `.env.example` pins). If Zitadel cannot be made to work inside the timebox, **fall back to Ory Kratos + Hydra** and record the decision. That fallback is not free: §4.2's single-project audience model, §6.7's `azp`-keyed scope workaround (Hydra emits `scope`, so it becomes the claim-based resolver), §9.1's claims gap, and tickets 4, 15, and 26 are Zitadel-specific and would be revised with it.

**Acceptance criteria:** a browser on the host logs in through Zitadel and lands on a page rendered by the containerized app showing `sub`, `email`, `iss`; the same works after `docker compose down -v && up`; the chosen host strategy is written down.

**Status:** Open.

---

### Ticket 4 — Bootstrap container: configure Zitadel and hand off configuration (3 h)

**Read first:** `docs/README.md` §4.2, §6.3.

**Description:** `apps/bootstrap` is a one-shot, idempotent TypeScript script (own Dockerfile, run as a compose service that the app services `depends_on` with `condition: service_completed_successfully`).

- Reads the bootstrap machine-user PAT from the shared volume; waits for Zitadel readiness.
- Creates (if absent, matched by name) the single Zitadel project `auth-stack-exercise` and, inside it, the OIDC application `dashboard-web` (Web, PKCE, grant types authorization code and refresh token, exact redirect URI `http://dashboard.localtest.me:3000/auth/callback`, post-logout URI `http://dashboard.localtest.me:3000/`, `backchannel_logout_uri` from `DASHBOARD_WEB_INTERNAL_URL` (`http://dashboard-web:3000/auth/backchannel-logout` in compose, `http://host.docker.internal:3000/...` under Tilt; the route itself arrives in ticket 18 and answers `404` until then), access token type JWT, ID token with userinfo claims). Ticket 16 adds the `tenancy-api` API application, ticket 19a `dashboard-api`, ticket 17 `tenancy-web`, phase 5 the comments pair. All applications share the project, so every user-bound token's `aud` covers every API (`docs/README.md` §4.2).
- SpiceDB steps are added later, in order: ticket 6 adds the schema write at start; ticket 15 adds the client-authority grants, `api_scope:<scope_id>#granted@client:<client id>` for each scope of each API the application calls (§6.7).
- Creates the seeded users (`alice`, `bob`, `carol`) through the v2 user API with verified emails and the dev password; skips existing users.
- Writes the handoff files to `/config` (the `./.local/config/` bind mount): `dashboard-web.env` (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_REDIRECT_URI`, `TENANCY_API_URL`), later one per app, and `apis.env` (`OIDC_ISSUER`, `OIDC_PROJECT_ID`, `OIDC_JWKS_URL`) sourced by every API's entrypoint. The Zitadel user IDs of the seeded users go to `seed.json` for ticket 12.
- Structured logging of every created/skipped object; exits non-zero on any failure so compose surfaces it.

**Files:** `apps/bootstrap/src/{index.ts,zitadel.ts,handoff.ts}`, `apps/bootstrap/Dockerfile`, compose service.

**Acceptance criteria:** fresh `docker compose up -d --wait` ends with bootstrap exited 0 and the three users able to log in through the ticket 3 page using the generated client ID; a second run creates nothing and exits 0.

**Tests:** unit tests for idempotency helpers (find-or-create) with the Zitadel client mocked.

**Status:** Open.

---

### Ticket 5 — Tiltfile and CI skeleton (1.5 h)

**Read first:** `CLAUDE.md` (conventions).

**Description:**

- `Tiltfile` using `docker_compose('./docker-compose.yml')` for the infrastructure (every service outside the `apps` profile, so no containerized app competes for the ports) and `local_resource` entries that run `pnpm --filter dashboard-web dev` (and later the APIs) on the host, loading `./.local/config/<app>.env` plus host-side connection strings (`localhost:5432`, `localhost:6379`, `localhost:50051`), so `tilt up` is the one-command developer loop. Document `tilt up` and plain `docker compose --profile apps up` in the root README.
- GitHub Actions workflow `ci.yml`: `pnpm install --frozen-lockfile`, `lint`, `type-check`, `test`, `docker compose config`, Gitleaks; a second job starts the infrastructure with `docker compose up -d --wait` (no `apps` profile) and runs `test:integration`, which tickets 6, 7, and 8 populate. Playwright and the full-stack smoke test are added in ticket 13. Node and pnpm through `jdx/mise-action` reading `mise.toml`. Concurrency group per branch.

**Acceptance criteria:** CI is green on `main`; `tilt up` starts the infra and the web app; `tilt down` leaves nothing running.

**Status:** Open.

---

## Phase 1 — Vertical slice (minimum viable submission)

### Ticket 6 — SpiceDB schema and `packages/authz` (3 h)

**Read first:** `docs/README.md` §6.2, §6.5, §7.

**Description:**

- `packages/authz/schema.zed` as §6.2 without the phase 5 `comment` definition (ticket 27 adds it), including the `client` and `api_scope` definitions for client authority (§6.7); `pnpm authz:validate` runs `zed validate` through the SpiceDB container (no local `zed` needed).
- Client factory from env (`SPICEDB_ENDPOINT`, `SPICEDB_PRESHARED_KEY`, insecure for localhost), using the promise API of `@authzed/authzed-node`.
- Typed helpers: `writeSchema()`, `writeRelationships(updates) → ZedToken`, `check({resource, permission, subject, consistency})`, `bulkCheck(items, consistency)` over `CheckBulkPermissions` (one consistency setting per request), `lookupResources({type, permission, subject, consistency})`, `deleteRelationships(filter)`. Object and subject references built from a small typed vocabulary (`organization`, `project`, `document`, `user`, `client`, `api_scope`) so typos fail at compile time; scope strings map to `api_scope` object IDs by replacing `:` with `_` (`documents:write` → `api_scope:documents_write`), in one function both bootstrap and the resolver use.
- `consistency` helper: `atLeastAsFresh(zedtoken) | fullyConsistent | minimizeLatency`; every call names its level explicitly (`docs/README.md` §7.3); until phase 3 the app passes `fullyConsistent` everywhere, which is correct and simplest, and ticket 21 switches listings to `minimizeLatency` and adds the session token.
- Bootstrap (ticket 4) gains a step: write the schema at start (idempotent).

**Tests:** integration tests against the compose SpiceDB (a Jest project tagged `integration`, run in CI with the SpiceDB service container): the schema loads; the §6.3 scenario produces the expected `check` results for Alice, Bob, Carol; `lookupResources(document, view, carol)` returns exactly Launch plan and Budget.

**Status:** Open.

---

### Ticket 7 — `packages/db-core`, `packages/tenancy`, `packages/documents`: schema, migrations, services (3.5 h)

**Read first:** `docs/README.md` §3.1 (ownership rules), §5, §6.5.

**Description:** The tenancy service and the documents domain as packages that each own a database; `packages/tenancy` runs behind `tenancy-api` from phase 1 (ticket 16); `packages/documents` runs in-process in `dashboard-web` during phase 1 and moves behind `dashboard-api` in phase 2.

- `packages/db-core`: `createDb(connectionString)` (Drizzle over `postgres-js`) and `runMigrations(db, folder)`; no tables.
- `packages/tenancy`: schema for `users` and `organizations` (including `policy`; `authz_decisions` arrives in phase 3); migrations; services `provisionUser(claims)` (ticket 10 fills it in), `getOrganization(user, id)` (policy, name; `organization#view` check), `listOrganizations(user)`, `setMembership(...)` and `setPolicy(...)` (used by `tenancy-web` in phase 2); a `TenancyClient` interface, exported from the subpath `@auth-stack/tenancy/client` together with the HTTP implementation (ticket 16) and the request/response types only, so that domain packages and BFFs import the client without the schema or database code; the package root (schema, migrations, services) is imported only by `tenancy-api` and bootstrap. An in-process implementation lives in the package root for unit tests.
- `packages/documents`: schema for `projects` and `documents` (§5.2); migrations; services `listVisibleDocuments(user, consistency)`, `getDocumentForEdit(user, id)`, `updateDocument(user, id, values)`, `ensurePersonalProject(user, orgId)` (idempotent on a partial unique index over `projects (organization_id) WHERE is_personal`; creates the "Personal" project and the example document "Welcome" with `value_1 = "Hello"`, `value_2 = "World"`, and writes their tuples), each calling `packages/authz` before touching data and `TenancyClient` for the organization (ticket 11 fills them in). Seed helpers live in both packages and are invoked by bootstrap.
- `pnpm db:migrate --filter <package>` scripts for development; in compose, **bootstrap runs every package's migrations** before seeding (it already imports both packages' seed helpers and the apps `depends_on` it), which is the only order that works; the migrations themselves stay owned by their package, bootstrap is only the executor, and the README's trade-offs section says so.

**Tests:** migrations apply on fresh databases in CI; a round-trip insert/select per table.

**Status:** Open.

---

### Ticket 8 — `packages/auth`: OIDC client, `SessionStore` interface, Redis adapter (3.5 h)

**Read first:** `docs/README.md` §4.4, §9.

**Description:** The BFF half of the package (the bearer half is ticket 15, which follows immediately; the back-channel logout sink is ticket 18; the policy helper is ticket 24).

- Framework-agnostic core on the Fetch API: `createOidcClient(config)` from discovery (`openid-client` v6), cached per process; `beginLogin()` → authorization URL plus the `state`, `nonce`, `code_verifier` to stash in a signed, short-lived (10 min) `HttpOnly` cookie; `completeLogin(callbackUrl, stash)` → validated tokens and claims (including `auth_time`, `amr`, `sid`, which Zitadel's claims matrix lists for the ID token); `getAccessToken(session)` → a valid access token, refreshing through the refresh token when it has less than 60 s left and updating the session (needed in phase 1 because `tenancy-api` is called on every render and access tokens live 10 minutes); failures map to typed errors (state mismatch, nonce mismatch, token invalid) that the route turns into a generic "login failed" page without leaking which check failed; `endSessionUrl(idToken, postLogoutRedirect)`.
- Session record: `{ id, sub, email, name, sid, accessToken, refreshToken, idToken, accessTokenExpiresAt, authTime, amr, createdAt, lastSeenAt, absoluteExpiresAt }`; ticket 21 adds `zedtoken`. Env contract of the package: `SESSION_SECRET` (signs the login stash cookie), `REDIS_URL`, `APP_URL` (decides `Secure` and the cookie origin), `SESSION_COOKIE_NAME` (default `<app>_session`, distinct per app since BFFs share `localtest.me`). `SessionStore` interface (modelled on `nextjs-auth0`'s `sessionStore`; `docs/README.md` §4.4): `create`, `get` (applies idle `30 min` and absolute `8 h` limits), `touch` (atomic conditional update: Lua script on Redis, so a logout in flight is never undone by a rolling write), `delete`, `deleteByLogoutToken({ sid, sub })`, `deleteByUser`, `listByUser`. Adapters: `createMemorySessionStore()` for tests and `createRedisSessionStore(client)` (session hash under `session:<id>` with TTL; secondary sets `sid:<sid>` and `user:<sub>`), the only dependency being an `ioredis`-compatible client passed in.
- Cookie helpers setting `HttpOnly`, `SameSite=Lax`, `Secure` when the app URL is https, `Path=/`; an `assertSameOrigin(request)` helper (`Origin`, falling back to `Sec-Fetch-Site`) for state-changing route handlers, since Next.js protects Server Actions but not route handlers (§9).
- Subpath export `@auth-stack/auth/next`: route-handler helpers bound to `cookies()` and `NextResponse`.
- No tokens or session IDs in logs; a `redact()` helper used by every log call.
- README of the package: how to pick a store; the note that a relational adapter needs an expiry cleanup job or a partial index on `expires_at`.

**Tests:** unit tests with a fake OP (`nock` or `openid-client`'s test helpers): happy path, each failure path, cookie attributes; the `SessionStore` contract test run against both adapters (Redis through the compose service in CI), including idle and absolute expiry, `deleteByLogoutToken` with `sid` only, `sub` only, and both, and the logout-versus-touch race.

**Status:** Open.

---

### Ticket 15 — `packages/auth` bearer verification and scope gate (`@auth-stack/auth/fastify`) (2.5 h)

**Read first:** `docs/README.md` §4.4 (last paragraphs), §6.7.

**Description:** The resource-server half of `packages/auth`, needed by `tenancy-api` in phase 1 and by every later API. A Fastify plugin that verifies `Authorization: Bearer` JWTs against Zitadel's JWKS (`jose`), checks `iss`, `exp`, and that `aud` contains the project ID (bootstrap registers each API as an API application in the same project), and puts the subject on the request. **Scope gate** (`docs/README.md` §6.7): `requireScope(...)` per route, resolving effective scopes through the `ScopeResolver` interface, here the `packages/authz`-backed resolver (`LookupResources(api_scope, use, client:<azp>)`, cached per client; Zitadel's JWT access tokens carry `azp` and no `scope` claim); first-party clients are registered with every scope; failure is `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`. Request IDs and structured logging helpers shared by the APIs.

**Tests:** unit tests for the plugin (valid, expired, wrong audience, wrong issuer, malformed, missing scope, scope from registry vs from claim) with a test signer.

**Status:** Open.

---

### Ticket 16 — `tenancy-api` on Fastify and the HTTP `TenancyClient` (3 h)

**Read first:** `docs/README.md` §3.1, §5.1, §6.4, §6.6 (tenancy table).

**Description:** `apps/tenancy-api` over `packages/tenancy`, on the bearer plugin and scope gate from ticket 15 (scopes `tenancy:read`, `tenancy:write`), running as its own process from phase 1 because a dedicated tenancy service is part of what the project demonstrates: `POST /me/provision` (idempotent, §6.4), `GET /me/organizations`, `GET /organizations/:id` (name, `is_personal`, policy; `organization#view`), writing organization relationships to SpiceDB (and checking `organization#view` at `fully_consistent` until ticket 21). Membership and policy endpoints arrive with `tenancy-web` (ticket 17). The HTTP `TenancyClient` in `packages/tenancy` with the per-organization cache (60 s); the in-process implementation stays for unit tests only. Health endpoint, Dockerfile, compose service, bootstrap registers the API application and its scopes.

**Tests:** route tests with a test signer; `TenancyClient` contract test against both implementations.

**Status:** Open.

---

### Ticket 9 — `dashboard-web` app shell: login, logout, protected routes (2 h)

**Read first:** `docs/README.md` §4.4.

**Description:** Replace the spike page with the real app skeleton: `/` (public landing with "Log in"), `/auth/login`, `/auth/callback`, `/auth/logout` (a `POST` route handler guarded by `assertSameOrigin`), `/dashboard` (protected). `proxy.ts` redirects unauthenticated requests under `/dashboard` to `/auth/login`. A `getCurrentUser()` server helper reads the session once per request. Minimal CSS, no component library. Refines the Dockerfile, compose service, and entrypoint from ticket 3.

**Acceptance criteria:** log in as Alice, see "Welcome, Alice" on `/dashboard`; log out and `/dashboard` redirects to login; the Zitadel session is ended too (visiting Zitadel's login shows the form again).

**Status:** Open.

---

### Ticket 10 — Just-in-time provisioning and personal workspace (2 h)

**Read first:** `docs/README.md` §6.4.

**Description:** In the callback, after session creation, two idempotent calls (§6.4). First `TenancyClient.provisionUser()` over HTTP to `tenancy-api` with the user's access token; `tenancy-api` takes `sub` from the token and, on the first call for that `sub`, fetches `email` and `name` from Zitadel's userinfo endpoint with the same token (verified by the IdP, no trust in the caller's body), inserts the `users` row, creates the personal organization (absent-check on the partial unique index), and writes its tuples; it returns the organization. Second, the BFF calls the documents domain's `ensurePersonalProject(user, orgId)` (in-process in phase 1; `POST /organizations/:id/personal-project` on `dashboard-api` from phase 2), which creates the "Personal" project and the "Welcome" document and writes their tuples. Both steps key on absence of the thing they create, not on the `users` row, so seeded users (ticket 12) get their personal workspace on first login too. ZedTokens are not stored until ticket 21. Idempotent and race-safe per §6.4: `INSERT ... ON CONFLICT DO NOTHING` on `users.id` with a read of the winner, the partial unique index on `organizations (owner_id) WHERE is_personal`, and `TOUCH` semantics on the relationship writes; the call runs on every login callback and returns the existing user after the first.

**Tests:** integration test: a new `sub` gets exactly one personal organization, one project, one document, and `check(document, edit, user)` allows; a second call creates nothing; ten concurrent first calls for the same `sub` leave exactly one of each.

**Status:** Open.

---

### Ticket 11 — Dashboard with the three states, and the edit flow with server-side enforcement (3 h)

**Read first:** `docs/README.md` §6.5.

**Description:**

- `packages/documents` services: `listVisibleDocuments(user, consistency)` (one `lookupResources(document, view, user)` → join IDs to `documents` rows with project names and, through `TenancyClient`, organization names → one `bulkCheck` of `edit` over the rows; `consistency` is `fullyConsistent` throughout phase 1 and becomes the §7.3 levels in ticket 21), `getDocumentForEdit(user, id)` (check `edit`; `view`-only → `403`; neither → `404`), `updateDocument(user, id, values)` (same check at `fully_consistent`, then update `value_1`, `value_2` (zod: strings of 1–200 characters), `updated_by`).
- `/dashboard` renders one row per document grouped by organization and project, with "Edit" or a disabled "Read-only" marker.
- `/documents/[id]/edit` renders the form (server component) that posts to the route handler `POST /documents/[id]/edit` guarded by `assertSameOrigin` (§9), which validates input with zod, calls `updateDocument`, and redirects back with a flash message. Route handlers rather than Server Actions, so that enforcement is a visible HTTP endpoint a reviewer can replay with `curl`. Forbidden and not-found states render proper pages.

**Acceptance criteria:** with the seeded users (ticket 12): Alice edits everything; Bob edits Marketing and never sees Finance; Carol edits Launch plan, sees Budget read-only, never sees Payroll; a `curl` `POST` to Budget's edit route with Carol's cookie returns `403`; to Payroll returns `404`.

**Status:** Open.

---

### Ticket 12 — Seeds: Acme organization, projects, documents, relationships (1.5 h)

**Read first:** `docs/README.md` §6.3.

**Description:** Bootstrap gains a seeding step after migrations and Zitadel users exist: through `packages/tenancy`, the `users` mirror rows for Alice, Bob, Carol (IDs from `seed.json`) and the Acme organization (`policy` `{}`); through `packages/documents`, the Marketing and Finance projects and the three documents; the relationship tuples from §6.3 (organization level by tenancy, project and document level by documents). Primary keys are UUIDs; the seeds use fixed UUID constants so reruns match, and the names in §6.3 (`acme`, `marketing`, `launch-plan`) are labels, not identifiers. Personal workspaces are not seeded; each user gets one on first login (ticket 10). Idempotent (match by the fixed IDs, skip if present).

**Acceptance criteria:** fresh stack → log in as each seeded user → the §6.3 dashboard table holds exactly for Acme, plus one personal "Welcome" document per user.

**Status:** Open.

---

### Ticket 13 — Playwright end-to-end: login and edit for the three users (2 h)

**Read first:** `docs/README.md` §6.3.

**Description:** `apps/dashboard-web/e2e/` with one spec per seeded user walking login → dashboard → edit (or read-only) → save → logout, plus one spec for the forbidden `POST`. Runs against the compose stack; CI job starts the stack with `--wait`, runs Playwright, uploads the trace on failure.

**Acceptance criteria:** green locally and in CI.

**Status:** Open.

---

### Ticket 14 — Root README v1: run instructions, architecture, trade-offs 📝 docs (2 h)

**Read first:** `docs/README.md` (all).

**Description:** Write the human-readable README: what this is, architecture diagram and a short tour of the repo, how to run (compose; Tilt), the seeded users table, how to try the three states, how authorization and consistency work in two paragraphs each, the security posture summary, **trade-offs, shortcuts, and gaps** (an explicit list, updated every phase), and **future work** (every unreached phase, from `docs/README.md` §11). Link to `docs/README.md` for the full design.

**Acceptance criteria:** a reader who has never seen the repo can run it and see the three states in under ten minutes following only the README. With ticket 14 merged, the submission is viable.

**Status:** Open.

---

## Phase 2 — Services: dashboard-api, tenancy-web, single sign-on and sign-out

### Ticket 19a — `dashboard-api` on Fastify (2 h)

**Read first:** `docs/README.md` §3.1, §6.5, §6.7.

**Description:** `apps/dashboard-api` exposing `GET /documents`, `GET /documents/:id`, `PUT /documents/:id`, `PUT /documents/:id/shares` (member IDs only, `document#share`), `POST /organizations/:id/personal-project` over `packages/documents`, on the bearer plugin and scope gate from ticket 15 (`documents:read` on `GET`, `documents:write` on `PUT`). Organization data through the HTTP `TenancyClient`. Health endpoint, Dockerfile, compose service; bootstrap registers the API application and its scopes.

**Tests:** integration test for the routes with a token minted by a test signer, including the `403`/`404` cases of §6.5.

**Status:** Open.

---

### Ticket 17 — `tenancy-web`: organizations, members, policy (2.5 h)

**Read first:** `docs/README.md` §3.1, §6.8, §9.1.

**Description:** `tenancy-api` gains `GET|PUT /organizations/:id/members` and `PUT /organizations/:id/policy` (`organization#administer`). A second Next.js app on `packages/auth` plus the `next` adapter, its own OIDC application and `backchannel_logout_uri` registered by bootstrap: `/organizations` (mine), `/organizations/[id]` (member list with role toggle and remove, for admins; read-only list for members, which is also the share picker's source; policy form: require MFA, maximum login age, required IdP). No add-member form: joining is by invitation (ticket 17a). Every action goes through `tenancy-api` with the user's token. Minimal UI; the point of the ticket is how little the second client contains, and the README says so.

**Acceptance criteria:** Alice demotes Bob to member and back; a member cannot open the policy form; Carol sees the member list but no controls.

**Status:** Open.

---

### Ticket 17a — Invitations with a uniform response (2 h, optional: only if Saturday allows)

**Read first:** `docs/README.md` §5.1 (`invitations`), §6.8.

**Description:** `tenancy-api`: `POST /organizations/:id/invitations` (`organization#administer`; stores the row with a hashed random token and a 7-day expiry; sends the email through SMTP with `nodemailer`; always answers `202` with the same body), `GET /invitations/:token` and `POST /invitations/:token/accept` (signed-in user whose email matches; writes the tuple at `fully_consistent`; marks accepted; expired, used, and unknown tokens all answer the same `404`). `tenancy-web`: an invite form on the organization page for admins and an `/invitations/[token]` accept page that sends an unauthenticated visitor through login first. Rate limits per §6.8: per inviting user and per organization through `@fastify/rate-limit`, and a per-address cooldown enforced from the latest invitation row for that email; `429` on breach, uniform `202` otherwise.

**Acceptance criteria:** Alice invites an unknown email and an existing account's email and sees the identical response; both emails appear in Mailpit; following the link as the existing account joins Acme; a second use of the link fails like an unknown one.

**Status:** Open.

---

### Ticket 18 — Back-channel logout sink in `packages/auth` (2 h)

**Read first:** `docs/README.md` §4.4 (step 6).

**Description:** `POST /auth/backchannel-logout` handler in the core with a `next` binding: validate the logout token (signature, `iss`, `aud`, `iat`, `exp`, `events`, `sid` or `sub`, no `nonce`), `deleteByLogoutToken({ sid, sub })`, `200` on success, `400` on an invalid token, never a redirect; mounted on `dashboard-web` and `tenancy-web` (their URIs were registered by tickets 4 and 17). Confirm empirically that a sign-out through `end_session` delivers the token inside compose, and whether admin session termination does too; record both as a dated note in §4.4.

**Tests:** unit tests with a signed fake logout token; integration test: logout in Zitadel removes the Redis session.

**Status:** Open.

---

### Ticket 19 — `dashboard-web` calls `dashboard-api` with the session's access token (2 h)

**Read first:** `docs/README.md` §4.4.

**Description:** Replace direct `packages/documents` calls in the web app with an HTTP client to `dashboard-api` that attaches the session's access token (tenancy has been over HTTP since ticket 16), refresh it with the refresh token when expired (updating the session), and map `401/403/404` to the existing pages. `packages/documents` is imported only by `dashboard-api` from here on. The three-state behaviour and the Playwright suite must be unchanged.

**Acceptance criteria:** Playwright green; the web container has no SpiceDB or domain-database connection any more (only Redis for sessions).

**Status:** Open.

---

### Ticket 20 — Single sign-on and single sign-out end to end (1.5 h)

**Read first:** `docs/README.md` §4.4.

**Description:** Playwright: log in on `dashboard-web`, open `tenancy-web` and be signed in without a prompt; sign out on `tenancy-web` and have `dashboard-web`'s next request redirect to login (through the back-channel logout sink, with the re-validation backstop as the fallback assertion).

**Acceptance criteria:** green locally and in CI.

**Status:** Open.

---

## Phase 3 — Consistency and audit (stubs; specified when the phase starts)

### Ticket 21 — Consistency per operation and session-scoped ZedTokens (2.5 h)

Apply `docs/README.md` §7.3 everywhere: listings at `minimize_latency`, every write-path check at `fully_consistent`, and after any relationship write by a user the API returns the ZedToken, the BFF stores it in the session (`zedtoken` field), and passes it back as the `X-Consistency-Token` header on that user's subsequent listing calls, which the API turns into `at_least_as_fresh` (so the BFF never imports `packages/authz`). A minimal share action in `dashboard-web` (pick a member of the organization, grant `document#viewer` or `#editor` through `PUT /documents/:id/shares`) exists so the read-your-writes test has a write to make. Integration test reproducing New Enemy case 1 (remove then add) with `minimize_latency` versus `fully_consistent`, and a read-your-writes test: share a document, list immediately with the session token, see it.

**Status:** Open.

### Ticket 22 — Decision audit log and per-organization audit page (2.5 h)

`authz_decisions` in tenancy, written at every enforcement point through a `recordDecision()` hook that posts asynchronously to `tenancy-api` (`POST /decisions`, buffered) using the posting API's own client-credentials token (scope `audit:write`, granted to each API's client by bootstrap: the one no-user call in scope); `/organizations/[id]/audit` page in `tenancy-web` for organization admins; retention note in the README.

**Status:** Open.

---

## Phase 4 — Hardening (stubs)

### Ticket 23 — CSRF tokens, security headers, CSP, rate limits (3 h)

Per-session synchronizer token in forms (the origin checks exist since phase 1); headers per `docs/README.md` §9 in `next.config.ts` and a Fastify hook; `@fastify/rate-limit` on mutations; a small token bucket on the callback route and the back-channel logout sink.

**Status:** Open.

### Ticket 24 — Authentication-context policies: `requireAuthContext` and the step-up flow (3 h)

`organizations.policy` (from tenancy, cached) honoured by the BFFs: `requireAuthContext({ maxAge, amr })` in `packages/auth` reads `auth_time` and `amr` from the session, produces the RFC 9470 challenge, and the web apps turn it into a re-authentication (`prompt=login`, `max_age`) and retry. The seeded Acme organization gets `policy.max_auth_age_seconds: 600` (policy is per organization, §5.1) so a reviewer who logged in more than ten minutes earlier sees a step-up on their next write; personal organizations keep `{}`. README section on where policies live (§9.1).

**Status:** Open.

### Ticket 25 — Test coverage pass and README trade-offs update (2 h)

Fill gaps in unit and integration coverage, `pnpm audit` in CI (non-blocking), refresh the trade-offs and gaps section.

**Status:** Open.

---

## Phase 5 — Comments domain: cross-domain access (stubs; only if time allows)

### Ticket 26 — Zitadel spike: RFC 9068 claims through Actions 🔬 spike (1.5 h, timeboxed)

Try a Zitadel Action that adds `auth_time` and `amr` to the JWT access token; record the outcome in `docs/README.md` §9.1 as a dated note (if it works, ticket 28 enforces policies in the APIs; if not, the limitation stands).

**Status:** Open.

### Ticket 27 — `packages/comments` and `comments-api` (3 h)

Schema (§5.3) and migrations, `comments` database in compose, Fastify API with `GET /documents/:id/comments` and `POST /documents/:id/comments` (scopes `comments:read`, `comments:write`); `comment` definition in the SpiceDB schema; permission checks through `document->view` at the per-operation consistency of §7; document title fetched from `dashboard-api` with the caller's access token (§6.6); bootstrap registers `comments-api` in the same project.

**Status:** Open.

### Ticket 28 — `comments-web` and the cross-domain end-to-end test (2.5 h)

A third Next.js app on the platform packages listing the documents the user can view with their comments and a form to add one; Playwright: Carol comments on Launch plan, cannot on Payroll (`404`), and sees her comment's document title fetched across domains. If ticket 26 succeeded, `dashboard-api` enforces `organizations.policy` with `requireAuthContext` on the access token for calls arriving from `comments-api`.

**Status:** Open.

---

## Phase 6 — Observability (stub)

### Ticket 29 — OpenTelemetry tracing across web, APIs, SpiceDB, and Postgres (3 h)

Node SDK with auto-instrumentations, manual spans around `authz` calls carrying the consistency mode, OTLP export to a collector and Jaeger in a compose `observability` profile; Zitadel's own tracing enabled through its env vars.

**Status:** Open.

---

## Phase 7 — Kubernetes (stub)

### Ticket 30 — Manifests and a Kubernetes Tiltfile (4 h)

`kind` cluster, Kustomize manifests for every service, a `Tiltfile.k8s`, README section.

**Status:** Open.

---

## Phase 8 — Gateway (stub)

### Ticket 31 — Traefik ForwardAuth or Envoy `ext_authz` in front of the APIs (3 h)

Configuration-only: token verification moves to the gateway; the APIs trust injected headers only from the gateway network.

**Status:** Open.

---

## Phase 9 — Identity extensions (stub)

### Ticket 32 — Broker a second OIDC provider through Zitadel (3 h)

A second Zitadel instance or a mock OIDC provider registered as an external IdP, with the seeded Acme organization's policy requiring it, demonstrating enterprise SSO without app changes.

**Status:** Open.
