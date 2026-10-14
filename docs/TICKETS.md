# Auth Stack Exercise — Tickets

> **📜 Decision log.** Per-ticket planning and decision record. Statuses and decisions are dated snapshots: corrections are appended as dated notes (`> **YYYY-MM-DD:** ...`) that win over earlier text, never silently rewritten.

> Each ticket is one PR unless marked **🔬 spike** (investigation; may produce no code) or **📝 docs** (documentation only).
>
> **Every code ticket must:**
>
> - Open the PR description with `Read first: docs/README.md` and name the ticket.
> - Pass `pnpm lint`, `pnpm type-check`, and `pnpm test` before "done".
> - Use conventional commits; one PR per ticket, merged with a merge commit (no squash); branch named `<nn>-<slug>`.
> - Update its **Status** line here in the same PR.
>
> Tickets are listed in implementation order. Phases 0–2 are fully specified; later phases are stubs that get specified with a dated note when the phase starts. Estimates are working hours including review.

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

- `pnpm-workspace.yaml` with `apps/*` and `packages/*`; root `package.json` with `packageManager` pinned and scripts `lint`, `type-check`, `test`, `test:e2e`, `format`.
- `mise.toml` pinning Node 22 (LTS; Next.js 16 needs ≥ 20.9) and pnpm.
- `tsconfig.base.json` (strict, `NodeNext` modules, `noUncheckedIndexedAccess`), `packages/config` holding shared tsconfig and ESLint presets.
- Root ESLint flat config (`eslint.config.mjs`) with `typescript-eslint`, `eslint-config-next` for the web app, import ordering; Prettier; `.editorconfig`.
- Jest at the root with `ts-jest` or `@swc/jest`, one placeholder test per package so the pipeline is green from the start.
- `.gitignore`, `.dockerignore`, `.nvmrc` mirror of the mise pin for tools that read it.
- Empty package skeletons: `packages/auth`, `packages/authz`, `packages/db-core`, `packages/documents`, `packages/config`, each with `package.json`, `tsconfig.json`, `src/index.ts`.

**Acceptance criteria:** `pnpm install`, `pnpm lint`, `pnpm type-check`, `pnpm test` all pass on a clean clone; `pnpm -r exec tsc --noEmit` resolves cross-package imports through workspace links.

**Status:** Open.

---

### Ticket 2 — Compose infrastructure: Postgres, Zitadel, Traefik, SpiceDB, Redis, Mailpit (2.5 h)

**Read first:** `docs/README.md` §4.2, §4.3.

**Description:** Bring up every third-party service with health checks and pinned images, starting from Zitadel's v4 reference compose (`deploy/compose/docker-compose.yml` in the Zitadel repository) trimmed to what this project needs.

- One `postgres:17-alpine` with an init script creating the databases (`zitadel`, `spicedb`, `documents`; `comments` is added in phase 5) and their users; health check with `pg_isready`.
- `zitadel-api` (`ghcr.io/zitadel/zitadel:v4.19.4`) with `start-from-init --masterkey`, `ZITADEL_EXTERNALDOMAIN/PORT/SECURE` from `.env`, `ZITADEL_TLS_ENABLED=false`, Login V2 settings, first-instance admin (`ZITADEL_FIRSTINSTANCE_ORG_HUMAN_*`, password-change not required), the login-client PAT path, and a **bootstrap machine user** (`ZITADEL_FIRSTINSTANCE_PATPATH=/zitadel/bootstrap/bootstrap.pat`, `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=bootstrap`, `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME`, `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE`); SMTP pointed at Mailpit (`ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_HOST=mailpit:1025`, `..._TLS=false`, `..._FROM=noreply@auth.localtest.me`, `..._FROMNAME`, `ZITADEL_DEFAULTINSTANCE_DOMAINPOLICY_SMTPSENDERADDRESSMATCHESINSTANCEDOMAIN=false`); shared `zitadel-bootstrap` volume.
- `zitadel-login` (`ghcr.io/zitadel/zitadel-login:v4.19.4`) with `ZITADEL_API_URL`, `NEXT_PUBLIC_BASE_PATH=/ui/v2/login`, `ZITADEL_SERVICE_USER_TOKEN_FILE`, `ZITADEL_SESSION_COOKIE_SECRET`, `CUSTOM_REQUEST_HEADERS`.
- `proxy` (Traefik v3) with the reference routing labels, published on `8080`.
- `spicedb-migrate` (`authzed/spicedb:v1.56.2`, `migrate head`) and `spicedb` (`serve --grpc-preshared-key ... --datastore-engine postgres --datastore-conn-uri ...`), gRPC on `50051`, HTTP gateway on `8443` optional; health check with `grpc_health_probe` or the `/healthz` endpoint.
- `redis` (`redis:7-alpine`) with `--appendonly yes` so sessions survive a restart; health check with `redis-cli ping`.
- `mailpit` (`axllent/mailpit:v1.31.5`), SMTP `1025`, UI published on `8025`.
- `.env.example` copied to `.env` by a `pnpm setup:env` script (or committed `.env` with insecure defaults; decide in the ticket and record), every variable commented.
- `docs/README.md` §4.3 option (a) wired as the default: `ZITADEL_DOMAIN=auth.localtest.me`, `ZITADEL_EXTERNALPORT=8080`, app services get `extra_hosts`. The spike (ticket 3) confirms or changes it.

**Files:** `docker-compose.yml`, `docker/postgres/init.sql`, `.env.example`, `docker/README.md` (what each service is for).

**Acceptance criteria:** `docker compose up -d --wait` reaches healthy on every service from a clean state in under three minutes on a laptop; `http://auth.localtest.me:8080` shows Zitadel's login; `http://localhost:8025` shows Mailpit; `grpcurl`/`zed` can reach SpiceDB with the preshared key; `docker compose down -v && docker compose up -d --wait` works twice in a row.

**Tests:** `docker compose config` validates in CI (ticket 5).

**Status:** Open.

---

### Ticket 3 — Zitadel spike: one real login from a Next.js page inside compose 🔬 spike (3 h, timeboxed)

**Read first:** `docs/README.md` §4.2–4.4.

**Description:** Prove the riskiest assumption before anything depends on it: that a containerized Next.js app can complete an authorization-code + PKCE login against the containerized Zitadel, with a single issuer string that the browser and the container both use.

- Create a throwaway OIDC application in Zitadel's console (bootstrap automates this in ticket 4): type Web, PKCE, redirect `http://localhost:3000/auth/callback`, post-logout `http://localhost:3000/`.
- A bare `apps/dashboard-web` (Next.js 16, App Router) with `/auth/login` and `/auth/callback` route handlers using `openid-client` v6 (`discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`), printing the ID-token claims on a page. No session yet.
- Run it inside compose with option (a) from §4.3. If discovery or the redirect fails on the issuer mismatch, try option (b) (custom fetch with a `Host` override). Record which one works and why as a dated note in `docs/README.md` §4.3.
- If `v4.19.4` misbehaves, retry with `v4.16.0` (the tag Zitadel's own `.env.example` pins). If Zitadel cannot be made to work inside the timebox, **fall back to Ory Kratos + Hydra** and record the decision; nothing else in the plan changes except §4.

**Acceptance criteria:** a browser on the host logs in through Zitadel and lands on a page rendered by the containerized app showing `sub`, `email`, `iss`; the same works after `docker compose down -v && up`; the chosen host strategy is written down.

**Status:** Open.

---

### Ticket 4 — Bootstrap container: configure Zitadel and hand off configuration (3 h)

**Read first:** `docs/README.md` §4.2, §6.3.

**Description:** `apps/bootstrap` is a one-shot, idempotent TypeScript script (own Dockerfile, run as a compose service that the app services `depends_on` with `condition: service_completed_successfully`).

- Reads the bootstrap machine-user PAT from the shared volume; waits for Zitadel readiness.
- Creates (if absent, matched by name) the single Zitadel project `auth-stack-exercise` and, inside it, the OIDC application `dashboard-web` (Web, PKCE, exact redirect URIs from env, post-logout URI, `backchannel_logout_uri`, access token type JWT, ID token with userinfo claims). Phase 2 adds the `dashboard-api` API application; phase 5 adds `comments-web` and `comments-api`. All applications share the project, so every user-bound token's `aud` covers every API (`docs/README.md` §4.2).
- Creates the seeded users (`alice`, `bob`, `carol`) through the v2 user API with verified emails and the dev password; skips existing users.
- Writes an env file to the shared volume (`/bootstrap/dashboard-web.env`: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, redirect URIs) that `dashboard-web`'s entrypoint sources before `next start`. The Zitadel user IDs of the seeded users are written to `/bootstrap/seed.json` for ticket 12.
- Structured logging of every created/skipped object; exits non-zero on any failure so compose surfaces it.

**Files:** `apps/bootstrap/src/{index.ts,zitadel.ts,handoff.ts}`, `apps/bootstrap/Dockerfile`, compose service.

**Acceptance criteria:** fresh `docker compose up -d --wait` ends with bootstrap exited 0 and the three users able to log in through the ticket 3 page using the generated client ID; a second run creates nothing and exits 0.

**Tests:** unit tests for idempotency helpers (find-or-create) with the Zitadel client mocked.

**Status:** Open.

---

### Ticket 5 — Tiltfile and CI skeleton (1.5 h)

**Read first:** `CLAUDE.md` (conventions).

**Description:**

- `Tiltfile` using `docker_compose('./docker-compose.yml')` for the infrastructure and `local_resource` entries that run `pnpm --filter dashboard-web dev` (and later the API) on the host with the right env, so `tilt up` is the one-command developer loop. Document `tilt up` and plain `docker compose up` in the root README.
- GitHub Actions workflow `ci.yml`: `pnpm install --frozen-lockfile`, `lint`, `type-check`, `test`, `docker compose config`, Gitleaks. Playwright and a compose smoke test are added in ticket 13. Node and pnpm from `mise.toml` (or `actions/setup-node` with the same pin). Concurrency group per branch.

**Acceptance criteria:** CI is green on `main`; `tilt up` starts the infra and the web app; `tilt down` leaves nothing running.

**Status:** Open.

---

## Phase 1 — Vertical slice (minimum viable submission)

### Ticket 6 — SpiceDB schema and `packages/authz` (3 h)

**Read first:** `docs/README.md` §6.2, §6.5, §7.

**Description:**

- `packages/authz/schema.zed` exactly as §6.2; `pnpm authz:validate` runs `zed validate` through the SpiceDB container (no local `zed` needed).
- Client factory from env (`SPICEDB_ENDPOINT`, `SPICEDB_PRESHARED_KEY`, insecure for localhost), using the promise API of `@authzed/authzed-node`.
- Typed helpers: `writeSchema()`, `writeRelationships(updates) → ZedToken`, `check({resource, permission, subject, consistency})`, `bulkCheck(items, consistency)` over `CheckBulkPermissions` (one consistency setting per request), `lookupResources({type, permission, subject, consistency})`, `deleteRelationships(filter)`. Object and subject references built from a small typed vocabulary (`organization`, `project`, `document`, `user`) so typos fail at compile time.
- `consistency` helper: `atLeastAsFresh(zedtoken) | fullyConsistent | minimizeLatency`; default for all app calls is `atLeastAsFresh` when a token is available, `fullyConsistent` otherwise (phase 3 wires the stored token; until then the helper is called with `fullyConsistent`).
- Bootstrap (ticket 4) gains a step: write the schema at start (idempotent).

**Tests:** integration tests against the compose SpiceDB (a Jest project tagged `integration`, run in CI with the SpiceDB service container): the schema loads; the §6.3 scenario produces the expected `check` results for Alice, Bob, Carol; `lookupResources(document, view, carol)` returns exactly Launch plan and Budget.

**Status:** Open.

---

### Ticket 7 — `packages/db-core` and `packages/documents`: schema, migrations, services (3 h)

**Read first:** `docs/README.md` §3.1 (ownership rules), §5.1, §6.5.

**Description:** The documents domain as one package that owns its database.

- `packages/db-core`: `createDb(connectionString)` (Drizzle over `postgres-js`) and `runMigrations(db, folder)`; no tables.
- `packages/documents`: Drizzle schema for `users`, `organizations` (including `zedtoken` and `policy`), `projects`, `documents` (§5.1; `authz_decisions` arrives in phase 3); `drizzle-kit` migrations committed; services `provisionUser(claims)` (ticket 10 fills it in), `listVisibleDocuments(user)`, `getDocumentForEdit(user, id)`, `updateDocument(user, id, values)`, each calling `packages/authz` before touching data (ticket 11 fills them in). Seed helpers live here and are invoked by bootstrap.
- `pnpm db:migrate --filter documents` script; migrations run from the app container entrypoint (phase 1: `dashboard-web`; from phase 2: `dashboard-api`) or from bootstrap; decide and record.
- The package is imported by `dashboard-web` in phase 1 and only by `dashboard-api` from phase 2; no other app ever imports it.

**Tests:** migration applies on a fresh database in CI; a round-trip insert/select per table.

**Status:** Open.

---

### Ticket 8 — `packages/auth`: OIDC client, `SessionStore` interface, Redis adapter (3.5 h)

**Read first:** `docs/README.md` §4.4, §9.

**Description:** The BFF half of the package (the bearer half is ticket 15; the back-channel logout sink and the policy helper are phase 5 and phase 4).

- Framework-agnostic core on the Fetch API: `createOidcClient(config)` from discovery (`openid-client` v6), cached per process; `beginLogin()` → authorization URL plus the `state`, `nonce`, `code_verifier` to stash in a signed, short-lived (10 min) `HttpOnly` cookie; `completeLogin(callbackUrl, stash)` → validated tokens and claims (including `auth_time`, `amr`, `sid`); failures map to typed errors (state mismatch, nonce mismatch, token invalid) that the route turns into a generic "login failed" page without leaking which check failed; `endSessionUrl(idToken, postLogoutRedirect)`.
- `SessionStore` interface: `create`, `get` (applies idle `30 min` and absolute `8 h` limits), `touch`, `delete`, `deleteBySid`, `deleteByUser`, `listByUser`. Adapters: `createMemorySessionStore()` for tests and `createRedisSessionStore(client)` (session hash under `session:<id>` with TTL; secondary sets `sid:<sid>` and `user:<sub>`), the only dependency being a `ioredis`-compatible client passed in.
- Cookie helpers setting `HttpOnly`, `SameSite=Lax`, `Secure` when the app URL is https, `Path=/`.
- Subpath export `@auth-stack/auth/next`: route-handler helpers bound to `cookies()` and `NextResponse`.
- No tokens or session IDs in logs; a `redact()` helper used by every log call.
- README of the package: how to pick a store; the note that a relational adapter needs an expiry cleanup job or a partial index on `expires_at`.

**Tests:** unit tests with a fake OP (`nock` or `openid-client`'s test helpers): happy path, each failure path, cookie attributes; the `SessionStore` contract test run against both adapters (Redis through the compose service in CI), including idle and absolute expiry and `deleteBySid`.

**Status:** Open.

---

### Ticket 9 — `dashboard-web` app shell: login, logout, protected routes (2 h)

**Read first:** `docs/README.md` §4.4.

**Description:** Replace the spike page with the real app skeleton: `/` (public landing with "Log in"), `/auth/login`, `/auth/callback`, `/auth/logout` (POST), `/dashboard` (protected). `proxy.ts` redirects unauthenticated requests under `/dashboard` to `/auth/login`. A `getCurrentUser()` server helper reads the session once per request. Minimal CSS, no component library. Entrypoint script sources the bootstrap env file. Dockerfile (multi-stage, `output: 'standalone'`).

**Acceptance criteria:** log in as Alice, see "Welcome, Alice" on `/dashboard`; log out and `/dashboard` redirects to login; the Zitadel session is ended too (visiting Zitadel's login shows the form again).

**Status:** Open.

---

### Ticket 10 — Just-in-time provisioning and personal workspace (2 h)

**Read first:** `docs/README.md` §6.4.

**Description:** In the callback, after session creation: if `users` has no row for `sub`, run the provisioning transaction from §6.4 through `packages/documents` (`provisionUser(claims)`), creating the personal organization, project, example document, and relationships, and storing the returned ZedToken on the organization. Idempotent under a double callback (unique constraint on `users.id`; retry-safe).

**Tests:** integration test: a new `sub` gets exactly one personal organization, one project, one document, and `check(document, edit, user)` allows; a second call creates nothing.

**Status:** Open.

---

### Ticket 11 — Dashboard with the three states, and the edit flow with server-side enforcement (3 h)

**Read first:** `docs/README.md` §6.5.

**Description:**

- `packages/documents` services: `listVisibleDocuments(user)` (one `lookupResources(document, view, user)` → join IDs to `documents` rows with project and organization names → group by `organization_id` → one `bulkCheck` per organization with that organization's ZedToken, checking `view` and `edit`), `getDocumentForEdit(user, id)` (check `edit`; `view`-only → `403`; neither → `404`), `updateDocument(user, id, values)` (same check, then update `value_1`, `value_2`, `updated_by`).
- `/dashboard` renders one row per document grouped by organization and project, with "Edit" or a disabled "Read-only" marker.
- `/documents/[id]/edit` renders the form (server component) and a server action or `POST` route handler that validates input with zod, calls `updateDocument`, and redirects back with a flash message. Forbidden and not-found states render proper pages.

**Acceptance criteria:** with the seeded users (ticket 12): Alice edits everything; Bob edits Marketing and never sees Finance; Carol edits Launch plan, sees Budget read-only, never sees Payroll; a `curl` `POST` to Budget's edit route with Carol's cookie returns `403`; to Payroll returns `404`.

**Status:** Open.

---

### Ticket 12 — Seeds: Acme organization, projects, documents, relationships (1.5 h)

**Read first:** `docs/README.md` §6.3.

**Description:** Bootstrap gains a seeding step after Zitadel users exist: insert the `users` mirror rows for Alice, Bob, Carol (IDs from `seed.json`), the Acme organization, Marketing and Finance projects, the three documents, and the relationship tuples from §6.3; store the ZedToken on Acme. Idempotent (match by stable names, skip if present).

**Acceptance criteria:** fresh stack → log in as each seeded user → the §6.3 dashboard table holds exactly.

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

## Phase 2 — Resource server

### Ticket 15 — `dashboard-api` on Fastify with bearer-token verification (3 h)

**Read first:** `docs/README.md` §3.1, §4.4 (last paragraph), §6.5.

**Description:** `apps/dashboard-api` exposing `GET /documents`, `GET /documents/:id`, `PUT /documents/:id` over `packages/documents`. The bearer half of `packages/auth`, exported as `@auth-stack/auth/fastify`: a plugin that verifies `Authorization: Bearer` JWTs against Zitadel's JWKS (`jose`), checks `iss`, `exp`, and that `aud` contains the project ID (bootstrap registers `dashboard-api` as an API application in the same project), and puts the subject on the request. Health endpoint, request IDs, structured logs, Dockerfile, compose service.

**Tests:** unit tests for the plugin (valid, expired, wrong audience, wrong issuer, malformed); integration test for the routes with a token minted by a test signer.

**Status:** Open.

---

### Ticket 16 — `dashboard-web` calls the API with the session's access token (2 h)

**Read first:** `docs/README.md` §4.4.

**Description:** Replace direct `packages/documents` calls in the web app with an HTTP client to `dashboard-api` that attaches the session's access token, refreshes it with the refresh token when expired (updating the session row), and maps `401/403/404` to the existing pages. `packages/documents` is imported only by the API from here on. The three-state behaviour and the Playwright suite must be unchanged.

**Acceptance criteria:** Playwright green; the web container has no SpiceDB or documents-database connection any more (only Redis for sessions).

**Status:** Open.

---

## Phase 3 — Consistency and audit (stubs; specified when the phase starts)

### Ticket 17 — ZedToken on organizations and `at_least_as_fresh` on every check (2 h)

Store the ZedToken returned by every relationship write on `organizations.zedtoken` (tickets 10 and 12 already do on create; this ticket covers every later write and switches the default consistency from `fullyConsistent` to `atLeastAsFresh(org.zedtoken)`). Integration test reproducing New Enemy case 1 with `minimize_latency` versus the stored token.

**Status:** Open.

### Ticket 18 — Decision audit log and per-organization audit page (2.5 h)

`authz_decisions` table written at every enforcement point through a `recordDecision()` hook in `packages/documents`; `/organizations/[id]/audit` page for organization admins; retention note in the README.

**Status:** Open.

---

## Phase 4 — Hardening (stubs)

### Ticket 19 — CSRF tokens, security headers, CSP, rate limits (3 h)

Per-session CSRF token in forms and server actions; `Origin`/`Sec-Fetch-Site` checks; headers per `docs/README.md` §9 in `next.config.ts` and a Fastify hook; `@fastify/rate-limit` on mutations; a small token bucket on the callback route.

**Status:** Open.

### Ticket 20 — Authentication-context policies: `requireAuthContext` and the step-up flow (3 h)

`organizations.policy` honoured by the BFF: `requireAuthContext({ maxAge, amr })` in `packages/auth` reads `auth_time` and `amr` from the session, produces the RFC 9470 challenge, and the web app turns it into a re-authentication (`prompt=login`, `max_age`) and retry. Finance in the seeded Acme organization gets `max_auth_age_seconds: 600` so the reviewer can see a step-up. README section on where policies live (§9.1).

**Status:** Open.

### Ticket 21 — Test coverage pass and README trade-offs update (2 h)

Fill gaps in unit and integration coverage, `pnpm audit` in CI (non-blocking), refresh the trade-offs and gaps section.

**Status:** Open.

---

## Phase 5 — Second application: single sign-on, single sign-out, cross-domain access (stubs)

### Ticket 22 — Zitadel spike: back-channel logout delivery and RFC 9068 claims through Actions 🔬 spike (2 h, timeboxed)

Confirm that a sign-out through `end_session` delivers a logout token to a registered `backchannel_logout_uri` inside compose, and whether admin session termination does too. Try a Zitadel Action that adds `auth_time` and `amr` to the JWT access token; record the outcome in `docs/README.md` §9.1 as a dated note (if it works, ticket 26 enforces policies in the APIs; if not, the limitation stands).

**Status:** Open.

### Ticket 23 — Back-channel logout sink in `packages/auth` (2 h)

`POST /auth/backchannel-logout` handler: validate the logout token (signature, `iss`, `aud`, `iat`, `exp`, `events`, `sid` or `sub`, no `nonce`), `deleteBySid` or `deleteByUser`, `200` on success, `400` on an invalid token, never a redirect; registered on `dashboard-web`; bootstrap sets the URI on the application. Unit tests with a signed fake logout token; integration test: logout in Zitadel removes the Redis session.

**Status:** Open.

### Ticket 24 — `packages/comments` and `comments-api` (3 h)

Schema (§5.2) and migrations, `comments` database in compose, Fastify API with `GET /documents/:id/comments` and `POST /documents/:id/comments`; `comment` definition added to the SpiceDB schema; permission checks through `document->view` on SpiceDB; document title fetched from `dashboard-api` with the caller's access token (§6.6); bootstrap registers `comments-api` in the same project.

**Status:** Open.

### Ticket 25 — `comments-web` on the platform packages (2.5 h)

A second Next.js app with `packages/auth` plus the `next` adapter, its own OIDC application and `backchannel_logout_uri` from bootstrap, a page listing the documents the user can view with their comments and a form to add one. The point of the ticket is how little it contains; the README says so.

**Status:** Open.

### Ticket 26 — Single sign-on and single sign-out end to end (2 h)

Playwright: log in on `dashboard-web`, open `comments-web` and be signed in without a prompt; sign out on `comments-web` and have `dashboard-web`'s next request redirect to login (through the back-channel logout sink, with the re-validation backstop as the fallback assertion). If ticket 22 showed Actions can emit the claims, `dashboard-api` enforces `organizations.policy` with `requireAuthContext` on the access token for calls arriving from `comments-api`.

**Status:** Open.

---

## Phase 6 — Observability (stub)

### Ticket 27 — OpenTelemetry tracing across web, APIs, SpiceDB, and Postgres (3 h)

Node SDK with auto-instrumentations, manual spans around `authz` calls carrying the consistency mode, OTLP export to a collector and Jaeger in a compose `observability` profile; Zitadel's own tracing enabled through its env vars.

**Status:** Open.

---

## Phase 7 — Kubernetes (stub)

### Ticket 28 — Manifests and a Kubernetes Tiltfile (4 h)

`kind` cluster, Kustomize manifests for every service, a `Tiltfile.k8s`, README section.

**Status:** Open.

---

## Phase 8 — Gateway (stub)

### Ticket 29 — Traefik ForwardAuth or Envoy `ext_authz` in front of the APIs (3 h)

Configuration-only: token verification moves to the gateway; the APIs trust injected headers only from the gateway network.

**Status:** Open.

---

## Phase 9 — Identity extensions (stub)

### Ticket 30 — Broker a second OIDC provider through Zitadel (3 h)

A second Zitadel instance or a mock OIDC provider registered as an external IdP, with the seeded Acme organization's policy requiring it, demonstrating enterprise SSO without app changes.

**Status:** Open.
