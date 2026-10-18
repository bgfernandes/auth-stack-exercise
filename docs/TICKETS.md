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
> - When it implements or changes a package under `packages/`, update that package's `README.md` (how to use it: env contract, entry points and subpaths, a usage example, how to run its checks) in the same PR (rule added 2026-10-17, in ticket 6).
>
> Tickets are listed in implementation order; ticket numbers are stable identifiers, not the order (tickets 15 and 16 moved into phase 1 on 2026-10-15 and kept their numbers). Phases 0–2 are fully specified; later phases are stubs that get specified with a dated note when the phase starts. Estimates are working hours including review.

---

## Phase 0 — Foundation

### Ticket 0 — Commit the architecture doc, this ticket list, and `CLAUDE.md` 📝 docs

**Description:** `docs/README.md`, `docs/TICKETS.md`, and `CLAUDE.md` are the shared context for every PR.

**Acceptance criteria:** the three files exist; the root `README.md` has a one-paragraph description and a pointer to `docs/README.md` (the full README is ticket 14); `.markdownlint-cli2.yaml`, the `lint:md` scripts, and a CI workflow running them are in place.

**Status:** Done (2026-10-15).

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
- CI: extend `.github/workflows/ci.yml` (already running `lint:md` from ticket 0) into a `checks` job: `pnpm install --frozen-lockfile`, `lint` (ESLint plus `lint:md`), `format:check` (Prettier), `type-check`, `test` (unit), and Gitleaks; Node and pnpm from `mise.toml` through `jdx/mise-action` (replacing the interim `setup-node`); concurrency group per branch. The pipeline is green on the scaffold before any feature lands.
- Empty package skeletons: `packages/auth`, `packages/authz`, `packages/db-core`, `packages/tenancy`, `packages/documents`, `packages/config`, each with `package.json`, `tsconfig.json`, `src/index.ts`. `.markdownlint-cli2.yaml` and the `lint:md` scripts from ticket 0 are kept and folded into `lint`.

**Acceptance criteria:** `pnpm install`, `pnpm lint`, `pnpm format:check`, `pnpm type-check`, `pnpm test` all pass on a clean clone and in CI; `pnpm -r exec tsc --noEmit` resolves cross-package imports through workspace links.

> **2026-10-15:** Pins chosen at implementation time: Node 22.23.3; pnpm 10.34.6 (pnpm 12.11.2 was the latest major, but the 10.x line still receives patches and is the one whose behaviour is known; moving is a one-line change in `mise.toml` and `packageManager`, which must stay equal because pnpm switches itself to the `packageManager` version); TypeScript 5.9.3 (typescript-eslint 8 supports `<6.1`, so the 7.x native compiler is outside the lint toolchain's range); ESLint 10.12.0 (ESLint 9 is end-of-life; the React plugins that `eslint-config-next` pulls in declare peer support up to 9 and run on 10, so the warning is silenced through `peerDependencyRules` in `pnpm-workspace.yaml`); Jest 30 with `@swc/jest`.

> **2026-10-15:** Workspace packages are consumed from source (`exports` → `src/index.ts`, no build step in packages); the decision and its cost are in `docs/README.md` §12. `packages/config` has no `src/index.ts`: it holds only the tsconfig and ESLint presets, and its own `tsconfig.json` type-checks the ESLint preset (`checkJs`) so that `pnpm -r exec tsc --noEmit` covers it. The shared tsconfig lives there (`packages/config/tsconfig/base.json`, no root `tsconfig.base.json`); the root `tsconfig.json` covers only the root config files, so editors and ESLint have a project for them, and `type-check` includes the workspace root and, beyond the three options the ticket names, turns on `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride`, and `noFallthroughCasesInSwitch`; `exactOptionalPropertyTypes` is the one that most often argues with third-party types and can be dropped in the ticket that first hits it. Gitleaks runs as its own `secrets` job next to `checks`, since it needs the full history and no Node.

> **2026-10-15:** `eslint-config-next` is installed in `packages/config` but switched off (`nextjs: false` in `eslint.config.mjs`) because it requires the `next` package at import time; ticket 3 turns it on when the first web app installs Next. `test:e2e` is a placeholder that fails with a pointer to ticket 13, so it can never pass by accident. Prettier ignores Markdown so that markdownlint stays the single authority on the docs.

> **2026-10-17 (ticket 8):** `NodeNext` gave way to bundler resolution in every tsconfig, and relative imports carry no extension anywhere; see the ticket 3 note and the decision log.

**Status:** Done (2026-10-15).

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

> **2026-10-15:** The **Files** line above is stale: the description and `docs/README.md` §9 want a committed `.env` and no `.env.example`, and that is what was built. Images are pinned to exact patch tags, not the floating minors named above: `postgres:17.11-alpine`, `redis:7.4.11-alpine`, `traefik:v3.7.14` (Docker Hub lagged the v3.7.15 GitHub release), `authzed/spicedb:v1.56.2`, `authzed/zed:v1.2.1`, `axllent/mailpit:v1.31.5`, Zitadel `v4.19.4` (v4.19.5 existed; the docs' pin was kept). Env key names were confirmed against `cmd/defaults.yaml` and `cmd/setup/steps.yaml` at that tag; the OIDC lifetime keys are as written above and need no change in the spike.

> **2026-10-15:** Findings from the acceptance run. Zitadel starts with `start-from-init` on a DSN whose role (`zitadel`) owns an existing database and is not a superuser, as `docker/postgres/init.sql` creates it; no admin DSN was needed. Traefik's `healthcheck` subcommand is a separate process that does not see the entrypoint flags of the main command, so the health check passes `--ping.entrypoint=web --entrypoints.web.address=:80` itself. The admin login name is `zitadel-admin@zitadel.auth.localtest.me` (Zitadel suffixes a non-email username with the default organization's domain). A clean `up -d --wait` took 80 s the first time and 23 s on the two following `down -v && up` cycles on a laptop; `spicedb-migrate` exits 0 and `--wait` accepts that. The `apps` profile is reserved for ticket 3; `zed` sits in a `tools` profile behind `pnpm authz:zed`.

**Status:** Done (2026-10-15).

---

### Ticket 3 — Zitadel spike: one real login from a Next.js page inside compose 🔬 spike (3 h, timeboxed)

**Read first:** `docs/README.md` §4.2–4.4.

**Description:** Prove the riskiest assumption before anything depends on it: that a containerized Next.js app can complete an authorization-code + PKCE login against the containerized Zitadel, with a single issuer string that the browser and the container both use.

- Create a throwaway OIDC application in Zitadel's console (bootstrap automates this in ticket 4): type Web, PKCE, redirect `http://localhost:3000/auth/callback`, post-logout `http://localhost:3000/`.
- A bare `apps/dashboard-web` (Next.js 16, App Router) with `/auth/login` and `/auth/callback` route handlers using `openid-client` v6 (`discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`), printing the ID-token claims on a page. No session yet. The spike commits the first `Dockerfile` (multi-stage, `output: 'standalone'`), the compose service (profile `apps`), and the entrypoint that sources `/config/dashboard-web.env`; ticket 9 refines them rather than creating them.
- Run it inside compose with option (a) from §4.3. If discovery or the redirect fails on the issuer mismatch, try option (b) (custom fetch with a `Host` override) and option (c) (a trusted domain for the service name, checking what `issuer` discovery returns and what `iss` the tokens carry when reached through it). Record which one works and why as a dated note in `docs/README.md` §4.3.
- If `v4.19.4` misbehaves, retry with `v4.16.0` (the tag Zitadel's own `.env.example` pins). If Zitadel cannot be made to work inside the timebox, **fall back to Ory Kratos + Hydra** and record the decision. That fallback is not free: §4.2's single-project audience model, §6.7's `azp`-keyed scope workaround (Hydra emits `scope`, so it becomes the claim-based resolver), §9.1's claims gap, and tickets 4, 15, and 26 are Zitadel-specific and would be revised with it.

**Acceptance criteria:** a browser on the host logs in through Zitadel and lands on a page rendered by the containerized app showing `sub`, `email`, `iss`; the same works after `docker compose down -v && up`; the chosen host strategy is written down.

> **2026-10-15:** This ticket also turns on the Next.js ESLint preset (`nextjs: true` in `eslint.config.mjs`) once `next` is installed, and gives the app a `tsconfig.json` extending `@auth-stack/config/tsconfig/next.json` (ticket 1).

> **2026-10-15 (result):** Option (a) works as designed and is kept; (b) and (c) were not needed. The browser and the container both use `http://auth.localtest.me:8080`: the container reaches it through `extra_hosts: auth.localtest.me:host-gateway` and Traefik's published port, discovery returns that issuer, and the ID token's `iss` is the same string. The ID token's `aud` carries the client ID and the project ID (§4.2 confirmed). Two findings for ticket 8: Zitadel accepts an `http://` redirect URI on a host other than `localhost` only with the application's dev mode on (the registration sets `devMode: true`; a TLS deployment turns it off); and the standalone Next.js server reports `request.url` on the bind address (`0.0.0.0:3000`), not the browser-facing host, so the callback must build `redirect_uri` from configuration and never from the request, or the token exchange fails with a redirect mismatch (which is exactly how the first attempt failed).

> **2026-10-15 (deviations):** The redirect URI is `http://dashboard.localtest.me:3000/auth/callback` (ticket 2's hostname scheme, what ticket 4 registers), not `localhost:3000`. The throwaway application is registered by `scripts/spike/register-dashboard-web.sh` through the management API (find-or-create by name; writes `.local/config/dashboard-web.env`) instead of by hand in the console, so the flow is repeatable after `down -v`; ticket 4 deletes the script. The spike keeps no session: the ID-token claims ride in a short-lived cookie so the page can print them, removed in ticket 8. The container health check probes `127.0.0.1`, since `localhost` resolves to `::1` inside the image and Next listens on IPv4. In Next.js apps relative imports carry no extension (Turbopack under `bundler` resolution does not remap `.js` to `.ts`), unlike the NodeNext packages; the rule is in `CLAUDE.md`. Verified end to end with a headless browser (Playwright, not committed; ticket 13), twice across a `down -v`.

> **2026-10-17 (ticket 8):** The extension rule above is superseded: relative imports carry no extension anywhere (every tsconfig on bundler resolution), because Turbopack does not remap `.js` to `.ts` inside the packages either, which a web app importing a package from source needs. See the decision log.

**Status:** Done (2026-10-15).

---

### Ticket 4 — Bootstrap container: configure Zitadel and hand off configuration (3 h)

**Read first:** `docs/README.md` §4.2, §6.3.

**Description:** `apps/bootstrap` is a one-shot, idempotent TypeScript script (own Dockerfile, run as a compose service that the app services `depends_on` with `condition: service_completed_successfully`).

- Reads the bootstrap machine-user PAT from the shared volume; waits for Zitadel readiness.
- Creates (if absent, matched by name) the single Zitadel project `auth-stack-exercise` and, inside it, the OIDC application `dashboard-web` (Web, PKCE, grant types authorization code and refresh token, exact redirect URI `http://dashboard.localtest.me:3000/auth/callback`, post-logout URI `http://dashboard.localtest.me:3000/`, `backchannel_logout_uri` from `DASHBOARD_WEB_INTERNAL_URL` (`http://dashboard-web:3000/auth/backchannel-logout` in compose, `http://host.docker.internal:3000/...` under Tilt; the route itself arrives in ticket 18 and answers `404` until then), access token type JWT, ID token with userinfo claims). Ticket 16 adds the `tenancy-api` API application, ticket 19a `dashboard-api`, ticket 17 `tenancy-web`, phase 5 the comments pair. All applications share the project, so every user-bound token's `aud` covers every API (`docs/README.md` §4.2).
- SpiceDB steps are added later, in order: ticket 6 adds the schema write at start; ticket 15 adds the client-authority grants, `api_scope:<scope_id>#grantee@client:<client id>` for each scope of each API the application calls (§6.7).
- Creates the seeded users (`alice`, `bob`, `carol`) through the v2 user API with verified emails and the dev password; skips existing users.
- Writes the handoff files to `/config` (the `./.local/config/` bind mount): `dashboard-web.env` (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_REDIRECT_URI`, `TENANCY_API_URL`), later one per app, and `apis.env` (`OIDC_ISSUER`, `OIDC_PROJECT_ID`, `OIDC_JWKS_URL`) sourced by every API's entrypoint. The Zitadel user IDs of the seeded users go to `seed.json` for ticket 12.
- Structured logging of every created/skipped object; exits non-zero on any failure so compose surfaces it.

**Files:** `apps/bootstrap/src/{index.ts,zitadel.ts,handoff.ts}`, `apps/bootstrap/Dockerfile`, compose service.

**Acceptance criteria:** fresh `docker compose up -d --wait` ends with bootstrap exited 0 and the three users able to log in through the ticket 3 page using the generated client ID; a second run creates nothing and exits 0.

**Tests:** unit tests for idempotency helpers (find-or-create) with the Zitadel client mocked.

> **2026-10-15 (deviations):** The back-channel logout URI is the application's **public** URL, `http://dashboard.localtest.me:3000/auth/backchannel-logout`, not an internal one: Zitadel resolves the URI's hostname when the application is registered and refuses it if the lookup fails, and the app's service name is not in DNS until the app starts, which is after bootstrap completes. So `zitadel-api` gets `extra_hosts: dashboard.localtest.me:host-gateway` and reaches the app through the host's published port, the mirror image of §4.3 option (a); the same URL works under Tilt, where the app listens on the host, and `DASHBOARD_WEB_INTERNAL_URL` does not exist. Zitadel's outbound HTTP client also refuses private and loopback addresses by default (`HTTPClient.DenyList`, the SSRF guard behind the `Errors.Project.App.Blocked.BackchannelLogoutURL` error), which is every address in this stack, so compose narrows the list to the link-local range (`ZITADEL_HTTPCLIENT_DENYLIST=169.254.0.0/16`); a real deployment keeps the default. The existing application is **reconciled**, not only found: when its registered settings differ from what bootstrap wants (a URI changed, a later ticket added one), the OIDC configuration is updated in place and logged `updated`; project and users stay find-or-create. The service runs in the default profile set, not under `apps`, so a plain `docker compose up` (Tilt, CI) produces the handoff files, and `dashboard-web` depends on it with `service_completed_successfully`. It runs as root like `zitadel-api`, because Docker creates the gitignored `./.local/config` bind mount root-owned on a Linux host. Build: one esbuild bundle (`apps/bootstrap/build.mjs`, `dist/index.js`) copied into a bare `node:alpine` image, the decision deferred by the scaffold entry of the decision log. The seeded users have username = email (`alice@example.com`), so their login name carries no organization domain suffix; verified by logging all three in through the ticket 3 page with a headless browser, and `seed.json` holds the `sub` each login returned. The spike script of ticket 3 is deleted. Zitadel talks: plain `fetch` against the REST endpoints (management v1 for project and application, user v2 for users) behind a `ZitadelApi` interface, no SDK.

> **2026-10-17 (correction, found in ticket 5):** The claim above that bootstrap runs in the default profile set so that a plain `docker compose up -d --wait` produces the handoff files was verified only with `--profile apps` and is wrong. Without the profile the command exits 1 with `container auth-stack-bootstrap-1 exited (0)`: compose's `--wait` accepts an exited one-shot only when a started service depends on it with `service_completed_successfully` (`getDependencyCondition` in `pkg/compose/start.go`, unchanged in the newest compose release), and bootstrap's only dependents are the apps, which the profile disables. Bootstrap now carries the profiles `apps` and `bootstrap`: the reviewer path's `up` is unchanged, and outside that profile it is an explicit step, `docker compose run --rm --build bootstrap`, which blocks until it finishes and returns its exit code, which is what Tilt and CI want from it anyway.

**Status:** Done (2026-10-15).

---

### Ticket 5 — Tiltfile and the CI integration job (1.5 h)

**Read first:** `CLAUDE.md` (conventions).

**Description:**

- `Tiltfile` using `docker_compose('./docker-compose.yml')` for the infrastructure (every service outside the `apps` profile, so no containerized app competes for the ports) and `local_resource` entries that run `pnpm --filter dashboard-web dev` (and later the APIs) on the host, loading `./.local/config/<app>.env` plus host-side connection strings (`localhost:5432`, `localhost:6379`, `localhost:50051`), so `tilt up` is the one-command developer loop. Document `tilt up` and plain `docker compose --profile apps up` in the root README's Development section.
- CI additions to `ci.yml` (the `checks` job exists since ticket 1): `docker compose config` validation, and an `integration` job that starts the infrastructure with `docker compose up -d --wait` (no `apps` profile) and runs `test:integration`, which tickets 6, 7, and 8 populate. Playwright and the full-stack smoke test are added in ticket 13.

**Acceptance criteria:** both CI jobs are green on `main`; `tilt up` starts the infra and the web app; `tilt down` leaves nothing running.

> **2026-10-15:** The bootstrap service (ticket 4) is in the default profile set, so `docker_compose` under Tilt and `docker compose up -d --wait` in the integration job both run it and get `./.local/config/` populated; the back-channel URI it registers is the app's public URL, which works for a Tilt-run app on the host without an override. `TENANCY_API_URL` in `dashboard-web.env` is the compose-internal URL and is the one value Tilt overrides with `localhost:4001`.

> **2026-10-17 (deviations):** There are exactly two ways to run the project, and the README documents no third: `tilt up` (infrastructure in compose, apps on the host) and `docker compose --profile apps up -d --wait --build` (everything in compose); they share port 3000, so one at a time. The infrastructure-without-apps sequence exists only inside the Tiltfile and the CI workflow. Bootstrap is not in the default set (ticket 4 correction above): Tilt runs it as a `local_resource` whose command is `docker compose run --rm --build bootstrap`, which waits for Zitadel through the service's `depends_on`, blocks until done, and fails the resource on a non-zero exit, so the apps' dependency on it is exact; it re-runs when `apps/bootstrap` changes. Three Tilt facts shaped the Tiltfile, all verified against Tilt's source and by running it: Tilt ignores the compose file's `name:` and derives the project name from the directory, so `project_name='auth-stack'` is passed; it starts every service with `up --no-deps` in `depends_on` order but considers a service started when its container runs, not when it is healthy, so `spicedb-migrate` gets `restart: on-failure` (it raced Postgres on a fresh volume) and the rest rely on their restart policies and on bootstrap's own readiness poll; its `wait=True` option appends `--wait` to each per-service `up`, which fails on every one-shot, so it is not used. `docker compose wait` cannot serve as the completion primitive either: it reports "no containers" once the container has exited. `profiles=[]` is passed so a `COMPOSE_PROFILES` in the shell cannot pull the containerized apps into Tilt. The app's env file is sourced in the `serve_cmd`, the way its `docker-entrypoint.sh` does, so it is read when the process starts rather than when the Tiltfile loads, and `TENANCY_API_URL` is exported after it. `next dev`, first used here, writes an `AGENTS.md` into the app directory on every start; `agentRules: false` in `next.config.ts` turns that off. A `pnpm-install` resource, watching `pnpm-lock.yaml` and `pnpm-workspace.yaml`, re-installs the workspace when a pulled commit changed the dependencies (CI's frozen lockfile guarantees the lockfile changes with them), and the host-run apps depend on it; bootstrap, which runs in Docker, does not. `tilt down` removes the containers and the network and keeps the volumes (`tilt down --delete-volumes` is the `down -v` equivalent). Tilt is pinned in `mise.toml` (0.37.8), so `mise install` provides it and `mise exec -- tilt up` runs the apps with the pinned pnpm; mise-action installs it in CI too, cached. CI: a composite action (`.github/actions/setup`) holds the mise, pnpm-cache, and install steps shared by `checks` and `integration`; `checks` validates the compose file with every profile (`docker compose --profile '*' config --quiet`); `integration` runs `docker compose up -d --wait`, then the bootstrap step, checks that the three handoff files exist and that the runner resolves `auth.localtest.me` by fetching the discovery document, runs `pnpm test:integration`, dumps `ps -a` and the last log lines on failure, and always tears down with `down -v`. Verified locally against the volumes of the existing stack: `tilt up` brought up the eight infrastructure services, ran bootstrap (`exists`, `unchanged`), started `dashboard-web` on the host, and `alice` logged in through it with the same issuer and `sub` as in compose; stopping Tilt killed the dev server and `tilt down` left no container running. The reviewer path with the moved bootstrap was verified the same way (`bob` logged in). Then on fresh volumes (`down -v`, no `.local/`): `tilt up` had the host app answering 19 s after the Tiltfile loaded, with the install step, the migration (no retry needed this time), bootstrap (`created` throughout), and the dev server in that order, and `carol` logged in with the `sub` written to the new `seed.json`.

**Status:** Done (2026-10-17).

---

## Phase 1 — Vertical slice (minimum viable submission)

### Ticket 6 — SpiceDB schema and `packages/authz` (3 h)

**Read first:** `docs/README.md` §6.2, §6.5, §7.

**Description:**

- `packages/authz/schema.zed` as §6.2 without the phase 5 `comment` definition (ticket 27 adds it), including the `client` and `api_scope` definitions for client authority (§6.7), with a `/** ... */` doc comment on every definition, relation, and permission (the sentences in §6.2's design points are the source), and `use typechecking` with complete permission annotations if SpiceDB v1.56.2 accepts it (drop it with a dated note if `WriteSchema` rejects the directive); `pnpm authz:validate` runs `zed validate` through the SpiceDB container (no local `zed` needed).
- Client factory from env (`SPICEDB_ENDPOINT`, `SPICEDB_PRESHARED_KEY`, insecure for localhost), using the promise API of `@authzed/authzed-node`.
- Typed helpers: `writeSchema()`, `writeRelationships(updates) → ZedToken`, `check({resource, permission, subject, consistency})`, `bulkCheck(items, consistency)` over `CheckBulkPermissions` (one consistency setting per request), `lookupResources({type, permission, subject, consistency})`, `deleteRelationships(filter)`. Object and subject references built from a small typed vocabulary (`organization`, `project`, `document`, `user`, `client`, `api_scope`) so typos fail at compile time; scope strings map to `api_scope` object IDs by replacing `:` with `_` (`documents:write` → `api_scope:documents_write`), in one function both bootstrap and the resolver use.
- `consistency` helper: `atLeastAsFresh(zedtoken) | fullyConsistent | minimizeLatency`; every call names its level explicitly (`docs/README.md` §7.3). `check` and `writeRelationships` return the ZedToken from the response so callers can store it with content. From phase 1: content reads use `atLeastAsFresh(row.zedtoken)`, write-path checks use `fullyConsistent`, and listings use `fullyConsistent` until ticket 21 switches them to `minimizeLatency`.
- Bootstrap (ticket 4) gains a step: write the schema at start (idempotent).

**Tests:** integration tests against the compose SpiceDB (a Jest project tagged `integration`, run in CI with the SpiceDB service container): the schema loads; the §6.3 scenario produces the expected `check` results for Alice, Bob, Carol; `lookupResources(document, view, carol)` returns exactly Launch plan and Budget.

> **2026-10-17 (planned in ticket 5):** This ticket is the first to touch the bootstrap Dockerfile after ticket 4 (it adds the SpiceDB client), so it also reorders the build to pnpm's documented Docker pattern: copy `pnpm-lock.yaml` alone and run `pnpm fetch`, which fills the store from the lockfile without any `package.json`, then copy the sources and run `pnpm install --offline --frozen-lockfile`. Today the sources are copied before the install, so every bootstrap source change invalidates the install layer and re-downloads the packages, which costs about 7 s per edit under Tilt (it rebuilds the image on each change) and 9 s per CI run. After the reorder the download layer depends on the lockfile only. A BuildKit cache in CI (`type=gha`) was considered in ticket 5 and declined: the whole bootstrap step is 26 s of a 93 s job, of which 9 s is the install, and restoring the cache would eat most of the gain; revisit once the integration tests make the job long enough for a stable 10 s to matter.

> **2026-10-17 (deviations):** `use typechecking` is in: SpiceDB v1.56.2 accepts the directive and rejects a wrong annotation at `WriteSchema` (`incomplete type annotation on relation ...`), and zed v1.2.1 rejects it offline the same way; the annotations are optional per permission as far as SpiceDB is concerned, so a unit test enforces that every permission in the file carries one, that every definition, relation, and permission carries a doc comment, and that the file matches the package's TypeScript vocabulary definition by definition. `ReadSchema` returns the schema re-serialized (directive and annotations dropped, definitions reordered), so bootstrap's `schema` log line reports `created`, `unchanged`, or `updated` by comparing the read-back before and after its write (`ensureSchema`), not the file against the read-back. The schema text reaches TypeScript as an import of `schema.zed` as text (esbuild's `text` loader in the bootstrap build, a one-line Jest transform), on the subpath `@auth-stack/authz/schema` that bootstrap and the integration tests import, so the web apps, which reach the package root through `packages/documents` in phase 1, need no bundler rule; the helper list's `writeSchema()` is `writeSchema(text)` on the client plus `ensureSchema(authz)` on the subpath. "Insecure for localhost" became an explicit `SPICEDB_INSECURE=true` (in `.env`, passed to bootstrap by compose): the client library's localhost mode sends no bearer to an endpoint that is not literally `localhost:*`, so `spicedb:50051` inside compose needs the plaintext-with-credentials mode, and inferring it from the hostname was rejected as a rule nobody expects; unset means TLS with the system's certificate authorities. Every call carries a 10 s deadline. `pnpm authz:validate` runs `zed validate --fail-on-warn` through the compose `zed` service, with `packages/authz` bind-mounted read-only and `--no-deps` so no server starts; the CI `checks` job runs it after the compose validation. The integration tests take `SPICEDB_PRESHARED_KEY` and `SPICEDB_INSECURE` from the root `.env` when the environment lacks them (parsed with `util.parseEnv`: `process.loadEnvFile` writes to the real `process.env`, which Jest replaces per test file) and default the endpoint to `localhost:50051`; their relationships carry an `it-` prefix and are deleted before and after. One test found that a `minimize_latency` check right after a schema write can be served from a snapshot predating the schema (`object definition document not found`), one quantization window of staleness that bootstrap's start order makes irrelevant for the apps; the test requires the scenario write's token with `at_least_as_fresh` instead, the §7.3 pattern. The Dockerfile reorder planned above was measured before being written, and `pnpm fetch` lost: it downloads the whole lockfile (619 packages, 4.6 s cold on a laptop, then a 0.9 s offline install) where the filtered install downloads bootstrap's closure only (2.3 s cold). The layout taken copies the lockfile and every workspace `package.json` first (`COPY --parents`, `docker/dockerfile:1.7-labs` syntax; `--frozen-lockfile` needs every importer's manifest present) and runs the same filtered install, so the install layer depends on the manifests only; a rebuild after a source edit reported it `CACHED` and reran only the esbuild step. The bundle grew to 6.1 MB with the gRPC client and its inline source map. Verified: the 17 new unit tests, the 18 integration tests against the compose SpiceDB, lint, type-check, Prettier, `authz:validate`, compose config with every profile, actionlint; `docker compose run --rm --build bootstrap` against the running stack logged `schema unchanged` (the integration tests had just written the same schema) and the ticket 4 steps as before, 9 s with the build, and the same on a second run; then the reviewer path on fresh volumes (`down -v`, no `.local/`) had every service healthy 50 s after `up`, with bootstrap logging `schema created` before the ticket 4 `created` steps, and `alice` logged in through the containerized app; `zed schema read` returns the schema with its doc comments; `tilt alpha tiltfile-result` shows the bootstrap resource with the two `packages/authz` paths in its `deps` and `spicedb` in its `resource_deps`.

> **2026-10-17 (package README):** `packages/authz/README.md` documents the env contract, the client and helpers with a usage example, the consistency rule per call, the schema subpath, and the checks; the first of the per-package READMEs the preamble now requires.

> **2026-10-17 (ticket 15):** `apiScope` and `scopeObjectId` moved from `packages/authz` to the new `packages/client-scopes`, which holds the whole §6.7 workaround; `packages/authz` keeps the `client` and `api_scope` schema definitions only.

**Status:** Done (2026-10-17).

---

### Ticket 7 — `packages/db-core`, `packages/tenancy`, `packages/documents`: schema, migrations, services (3.5 h)

**Read first:** `docs/README.md` §3.1 (ownership rules), §5, §6.5.

**Description:** The tenancy service and the documents domain as packages that each own a database; `packages/tenancy` runs behind `tenancy-api` from phase 1 (ticket 16); `packages/documents` runs in-process in `dashboard-web` during phase 1 and moves behind `dashboard-api` in phase 2.

- `packages/db-core`: `createDb(connectionString)` (Drizzle over `postgres-js`) and `runMigrations(db, folder)`; no tables.
- `packages/tenancy`: schema for `users` and `organizations` (including `policy`; `authz_decisions` arrives in phase 3); migrations; services `provisionUser(claims)` (ticket 10 fills it in), `getOrganization(user, id)` (policy, name; `organization#view` check), `listOrganizations(user)`, `setMembership(...)` and `setPolicy(...)` (used by `tenancy-web` in phase 2); a `TenancyClient` interface, exported from the subpath `@auth-stack/tenancy/client` together with the HTTP implementation (ticket 16) and the request/response types only, so that domain packages and BFFs import the client without the schema or database code; the package root (schema, migrations, services) is imported only by `tenancy-api` and bootstrap. An in-process implementation lives in the package root for unit tests.
- `packages/documents`: schema for `projects` and `documents` (§5.2, including `documents.zedtoken`, a `text` column); migrations; services `listVisibleDocuments(user, consistency)`, `getDocumentForEdit(user, id)`, `updateDocument(user, id, values)`, `ensurePersonalProject(user, orgId)` (idempotent on a partial unique index over `projects (organization_id) WHERE is_personal`; creates the "Personal" project and the example document "Welcome" with `value_1 = "Hello"`, `value_2 = "World"`, writes their tuples, and stores the relationship write's ZedToken on the document), each calling `packages/authz` before touching data and `TenancyClient` for the organization (ticket 11 fills them in). Seed helpers live in both packages and are invoked by bootstrap.
- `pnpm db:migrate --filter <package>` scripts for development; in compose, **bootstrap runs every package's migrations** before seeding (it already imports both packages' seed helpers and the apps `depends_on` it), which is the only order that works; the migrations themselves stay owned by their package, bootstrap is only the executor, and the README's trade-offs section says so.

**Tests:** migrations apply on fresh databases in CI; a round-trip insert/select per table.

> **2026-10-17 (deviations):** Drizzle 0.45.4 with drizzle-kit 0.31.11 (the 1.0 release candidate was not taken: its migrator and relational query APIs are still moving), postgres-js 3.4.9, zod 4.6.7. The services are implemented now rather than stubbed, since their inputs exist: tenancy's `provisionUser(claims)`, `getOrganization`, `listOrganizations`, `setMembership`, `setPolicy`, and documents' `ensurePersonalProject`, `listVisibleDocuments`, `getDocumentForEdit`, `updateDocument`, so tickets 10, 11, and 16 wire HTTP and UI around them. Each reads its consistency level from the caller (`fullyConsistent` throughout phase 1), takes `db`, `authz`, and the `TenancyClient` through a factory, and throws one error type per package with a `code` (`not_found`, `forbidden`, tenancy's `personal_organization`) that the API or the web app maps to a status; `UserContext` (`sub` plus the access token the HTTP client will forward) is the caller's identity on the client subpath, `Principal` (`sub`) on the service. `projects` gained `is_personal`, which the partial unique index this ticket names needs and §5.2 did not list (note there). Migrations are drizzle-kit's generated SQL (`packages/<p>/migrations/`, with the `meta/` snapshots committed and ignored by Prettier); `db:generate --name <change>` and `db:migrate` per package are `drizzle-kit`, so the ticket's `pnpm db:migrate --filter <package>` is `pnpm --filter @auth-stack/<package> db:migrate`, and a root `pnpm db:migrate` runs every package; bootstrap applies the same folders through `runMigrations` of `db-core`, which shares drizzle-kit's journal table, after the schema write and before the Zitadel steps, and its image copies the folders next to the bundle (`./migrations/<package>`), since a bundle cannot carry a folder the migrator reads at runtime. `TENANCY_DATABASE_URL` and `DOCUMENTS_DATABASE_URL` join `.env` beside the Zitadel and SpiceDB DSNs; compose passes them to bootstrap, which now also waits for a healthy Postgres. Seed helpers are left to ticket 12, where the data is defined. The service tests are integration tests, not unit tests with fakes: a Drizzle query has no meaningful fake, so each package's test owns a database on the compose Postgres (`it_tenancy`, `it_documents`, created through `@auth-stack/db-core/testing`), dropped with `WITH (FORCE)` before it is created so a crashed run never leaves more than one behind, and migrated from zero, which is the "fresh database" the ticket asks for; SpiceDB has no such unit, so the three integration files share the compose instance and isolate by data: fresh UUID resources and per-run subjects, every relationship written removed afterwards, and lookups that return an orphan filtered through a UUID check (the files run in parallel; the authz test's `it-` prefix cannot match a UUID); unit tests cover the two zod schemas. Two findings while writing them: a query sent through the pool from inside a transaction deadlocks under contention (every loser of the insert race held a pooled connection and waited for another), so the losing path reads through the transaction and `db-core`'s README says so; and a grant written directly to SpiceDB after a document's last write is invisible to reads at least as fresh as the row, which is the §7.3 reason the share action stores its token on the row, so the test does the same. The root README has no trade-offs section until ticket 14; the sentence about bootstrap executing migrations sits in its Development section until then. The bootstrap image's install layer, rebuilt because the manifests changed, took 3.8 s cold against the 2.3 s of ticket 6: drizzle-kit is a devDependency of the two service packages and the filtered install takes the devDependencies of every workspace package in bootstrap's closure; the bundle grew from 6.1 MB to 7.2 MB with Drizzle and postgres-js. Verified: lint, type-check, Prettier, the 8 new unit tests, the 34 integration tests (schema, provisioning, the three dashboard states, concurrency), compose config with every profile, actionlint, gitleaks; `docker compose run --rm --build bootstrap` against the running stack logged `migrations` for both databases after `schema unchanged`, the tables and the journal row exist in each, a second run was a no-op, `pnpm db:migrate` from the host found nothing pending, and no `it_*` database remained after the tests; then the reviewer path on fresh volumes (`down -v`, no `.local/`) had every service healthy 47 s after `up`, with bootstrap logging `schema created`, `migrations` for `tenancy` and `migrations` for `documents`, then the Zitadel `created` steps, both databases holding their tables and one journal row, and `bob` logged in through the containerized app.

> **2026-10-17:** Per the preamble rule added in ticket 6, this ticket writes or updates the README of every package it implements or changes (`packages/db-core`, `packages/tenancy`, `packages/documents`) in the same PR. Done: all three, with the root README pointing at them.

**Status:** Done (2026-10-17).

---

### Ticket 8 — `packages/auth`: OIDC client, `SessionStore` interface, Redis adapter (3.5 h)

**Read first:** `docs/README.md` §4.4, §9.

**Description:** The BFF half of the package (the bearer half is ticket 15, which follows immediately; the back-channel logout sink is ticket 18; the policy helper is ticket 24).

- Framework-agnostic core on the Fetch API: `createOidcClient(config)` from discovery (`openid-client` v6), cached per process; `beginLogin()` → authorization URL plus the `state`, `nonce`, `code_verifier` to stash in a signed, short-lived (10 min) `HttpOnly` cookie; `completeLogin(callbackUrl, stash)` → validated tokens and claims (including `auth_time`, `amr`, `sid`, which Zitadel's claims matrix lists for the ID token); `getAccessToken(session)` → a valid access token, refreshing through the refresh token when it has less than 60 s left and updating the session (needed in phase 1 because `tenancy-api` is called on every render and access tokens live 10 minutes); failures map to typed errors (state mismatch, nonce mismatch, token invalid) that the route turns into a generic "login failed" page without leaking which check failed; `endSessionUrl(idToken, postLogoutRedirect)`.
- Session record: `{ id, sub, email, name, sid, accessToken, refreshToken, idToken, accessTokenExpiresAt, authTime, amr, createdAt, lastSeenAt, absoluteExpiresAt }`. Env contract of the package: `SESSION_SECRET` (signs the login stash cookie), `REDIS_URL`, `APP_URL` (decides `Secure` and the cookie origin), `SESSION_COOKIE_NAME` (default `<app>_session`, distinct per app since BFFs share `localtest.me`). `SessionStore` interface (modelled on `nextjs-auth0`'s `sessionStore`; `docs/README.md` §4.4): `create`, `get` (applies idle `30 min` and absolute `8 h` limits), `touch` (atomic conditional update: Lua script on Redis, so a logout in flight is never undone by a rolling write), `delete`, `deleteByLogoutToken({ sid, sub })`, `deleteByUser`, `listByUser`. Adapters: `createMemorySessionStore()` for tests and `createRedisSessionStore(client)` (session hash under `session:<id>` with TTL; secondary sets `sid:<sid>` and `user:<sub>`), the only dependency being an `ioredis`-compatible client passed in.
- Cookie helpers setting `HttpOnly`, `SameSite=Lax`, `Secure` when the app URL is https, `Path=/`; an `assertSameOrigin(request)` helper (`Origin`, falling back to `Sec-Fetch-Site`) for state-changing route handlers, since Next.js protects Server Actions but not route handlers (§9).
- Subpath export `@auth-stack/auth/next`: route-handler helpers bound to `cookies()` and `NextResponse`.
- No tokens or session IDs in logs; a `redact()` helper used by every log call.
- README of the package: how to pick a store; the note that a relational adapter needs an expiry cleanup job or a partial index on `expires_at`.

**Tests:** unit tests with a fake OP (`nock` or `openid-client`'s test helpers): happy path, each failure path, cookie attributes; the `SessionStore` contract test run against both adapters (Redis through the compose service in CI), including idle and absolute expiry, `deleteByLogoutToken` with `sid` only, `sub` only, and both, and the logout-versus-touch race.

> **2026-10-17 (deviations):** Built as specified, with these differences. The `SessionStore` also has `update(id, patch): Promise<boolean>`, the optional atomic update of `nextjs-auth0`'s `sessionStore` that `docs/README.md` §4.4 names: it writes only to a session that still exists, reports whether it did, and resets the idle expiry, and it is how `getAccessToken` stores a refreshed token pair; `touch` keeps its single job, and there is no upsert. `getAccessToken` lives on a provider (`createAccessTokenProvider({ client, store })`) that deduplicates concurrent refreshes per session in the process (parallel server components of one render, and Zitadel rotates refresh tokens), re-reads the session when its refresh is refused in case another process refreshed first, and on `invalid_grant` deletes the session and returns `undefined`. `completeLogin` compares `state` itself before the exchange; the error codes are `no_login_in_progress`, `login_expired`, `state_mismatch`, `nonce_mismatch`, `authorization_denied`, `exchange_failed`, `token_invalid`, `refresh_failed`, and `forbidden_origin`, and the `next` binding answers every login failure with one generic response while logging the code through `redact`. `endSessionUrl(idToken)` takes the post-logout redirect from the client's configuration rather than as a second argument, since it is a registered URI. The stash cookie is scoped to the callback path rather than `/`; the session cookie is `Path=/`. The Redis adapter takes a `prefix` per app (the BFFs share one Redis, and the `sid` and `user` indexes must not mix) and needs four commands of an `ioredis`-compatible client (`eval`, `hgetall`, `smembers`, `srem`); `ioredis` 6 is a devDependency of the package for the integration test and a dependency of the apps. The rolling `touch` in the `next` binding runs at most once a minute per session. Tests use neither `nock` nor library test helpers (`openid-client` v6 has none): an in-process fake OP on the subpath `@auth-stack/auth/testing`, served through the library's `customFetch` hook, with `sign()` for the bearer and logout tokens of tickets 15 and 18; Jest transforms `openid-client`, `oauth4webapi`, and `jose`, which ship ES modules only. `next` is an optional peer dependency (and a devDependency) of the package. A `next build` probe of a route importing `@auth-stack/auth/next` found that Turbopack does not resolve the `.js` relative imports the packages used, which changed the workspace rule (CLAUDE.md; decision log). Env: `.env` gains `SESSION_SECRET` and `REDIS_URL`, bootstrap's handoff adds `APP_URL` to `dashboard-web.env`; wiring them into the dashboard-web compose service and the Tiltfile is ticket 9, with the routes. Timestamps in the session are epoch milliseconds (`authTime` included). Zitadel's instance settings were checked against the refresh premise: access and ID tokens live 600 s, refresh tokens 8 h.

**Status:** Done (2026-10-17).

---

### Ticket 15 — `packages/auth` bearer verification and scope gate (`@auth-stack/auth/fastify`) (2.5 h)

**Read first:** `docs/README.md` §4.4 (last paragraphs), §6.7.

**Description:** The resource-server half of `packages/auth`, needed by `tenancy-api` in phase 1 and by every later API. A Fastify plugin that verifies `Authorization: Bearer` JWTs against Zitadel's JWKS (`jose`), checks `iss`, `exp`, and that `aud` contains the project ID (bootstrap registers each API as an API application in the same project), and puts the subject on the request. **Scope gate** (`docs/README.md` §6.7): `requireScope(...)` per route, resolving effective scopes through the `ScopeResolver` interface, here the `packages/authz`-backed resolver (`LookupResources(api_scope, invoke, client:<azp>)`, cached per client; Zitadel's JWT access tokens carry `azp` and no `scope` claim); first-party clients are registered with every scope; failure is `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`. Request IDs and structured logging helpers shared by the APIs.

**Tests:** unit tests for the plugin (valid, expired, wrong audience, wrong issuer, malformed, missing scope, scope from registry vs from claim) with a test signer.

> **2026-10-17:** Per the preamble rule added in ticket 6, this ticket writes or updates the README of every package it implements or changes (`packages/auth`, its `fastify` subpath) in the same PR.

> **2026-10-17 (after ticket 8):** The test signer exists: the fake OP of `@auth-stack/auth/testing` signs any claims with its key (`sign()`) and serves the matching JWKS through its `fetch`. `jose` is a devDependency of the package since ticket 8; this ticket promotes it to a dependency.

> **2026-10-17 (deviations):** Built as specified, with these differences. A real Zitadel JWT access token (minted through a throwaway machine user with the client-credentials grant, then deleted) carries `client_id` and no `azp`, no `scope`, header `typ: JWT`; the ID token of the same response carries `azp`, `client_id`, `at_hash`, `auth_time`, `amr`. So the grants and the resolver key on `client_id`, and the plugin refuses a token with `at_hash` or `nonce` and requires `client_id`, since an ID token of the issuer passes the `iss`/`aud`/`exp` checks otherwise (its `aud` carries the project ID, ticket 3). The SpiceDB-backed resolver and the `apiScope`/`scopeObjectId` helpers of ticket 6 live in a new package, `packages/client-scopes`, chosen over `packages/authz` so the §6.7 workaround has a boundary and a deletion recipe (its README); `packages/authz` keeps only the schema definitions. The plugin denies by default: a global `onRequest` hook rejects every route without a valid bearer unless the route declares `config: { public: true }`; `fastify.requireScope(...)` is the per-route gate, validating the scope strings when the route is declared. Responses: `401` with `WWW-Authenticate: Bearer` (no token) or `Bearer error="invalid_token"`, `403` with `error="insufficient_scope", scope="..."`, a body of `{ error: <code> }` and nothing else. The shared server options (`apiServerOptions`) take a well-formed inbound `X-Request-Id` and generate one otherwise, log it as `requestId`, and redact `authorization`, `cookie`, and `set-cookie` headers; `echoRequestId(app)` echoes the ID on responses. `fastify` is an optional peer dependency like `next`; `fastify-plugin` and `jose` are dependencies. The resolver caches per client for 60 s at `minimizeLatency` (a `consistency` option exists for tests), deduplicating concurrent lookups. Jest additionally transforms `cookie`, which Fastify's request injector loads as an ES module. The aud of a user's access token obtained through dashboard-web (expected to carry the project ID like the ID token does) is confirmed in ticket 16, the first consumer.

**Status:** Done (2026-10-17).

---

### Ticket 16 — `tenancy-api` on Fastify and the HTTP `TenancyClient` (3 h)

**Read first:** `docs/README.md` §3.1, §5.1, §6.4, §6.6 (tenancy table).

**Description:** `apps/tenancy-api` over `packages/tenancy`, on the bearer plugin and scope gate from ticket 15 (scopes `tenancy:read`, `tenancy:write`), running as its own process from phase 1 because a dedicated tenancy service is part of what the project demonstrates: `POST /me/provision` (idempotent, §6.4), `GET /me/organizations`, `GET /organizations/:id` (name, `is_personal`, policy; `organization#view`), writing organization relationships to SpiceDB (and checking `organization#view` at `fully_consistent` until ticket 21). Membership and policy endpoints arrive with `tenancy-web` (ticket 17). The HTTP `TenancyClient` in `packages/tenancy` with the per-organization cache (60 s); the in-process implementation stays for unit tests only. Health endpoint, Dockerfile, compose service, bootstrap registers the API application and its scopes.

**Tests:** route tests with a test signer; `TenancyClient` contract test against both implementations.

> **2026-10-17 (after ticket 7):** The tenancy service and the `TenancyClient` interface (`@auth-stack/tenancy/client`, with `UserContext` carrying the access token) exist since ticket 7; this ticket adds the Fastify routes over the service, the HTTP client implementation, and maps `TenancyError` codes to statuses.

> **2026-10-17 (after ticket 15):** The API registers `bearerPlugin` from `@auth-stack/auth/fastify` with `createBearerVerifier(bearerOptionsFromEnv())` (reads `apis.env`) and `createScopeResolver(authz)` from `@auth-stack/client-scopes`, builds its server with `apiServerOptions()` and `echoRequestId(app)`, marks the health route `config: { public: true }`, and gates the rest with `app.requireScope('tenancy:read' | 'tenancy:write')`. Bootstrap writes the grants with `apiScope` and `client` from `@auth-stack/client-scopes`, keyed by the application's client ID. With the first real user token, confirm that its `aud` carries the project ID and that `client_id` is dashboard-web's client ID, and record it here.

> **2026-10-18 (real user token):** Confirmed with a token of `bob` obtained through dashboard-web's client (authorization code with PKCE, the login driven through Zitadel's session API with the Login V2 PAT, which is what the login UI does): the JWT access token carries `aud` of dashboard-web's client ID and the project ID, `client_id` of dashboard-web, header `typ: JWT`, no `azp` and no `scope`, as the ticket 15 machine token did. Once bootstrap registered the `tenancy-api` API application, its client ID joined the `aud` of the next token, which is §4.2 as written (the project ID plus the client IDs of every application in the project). Userinfo with that access token returns `sub`, `email`, `email_verified`, `name`, `given_name`, `family_name`, `preferred_username`; it refuses the ID token with `401`.

> **2026-10-18 (deviations):** Built as specified, with these differences. The API half of ticket 10 landed here, since `POST /me/provision` cannot work without it: on the first call for a `sub` (decided by the absence of the `users` row, through a new `getUser(sub)` on the service) the API fetches email and name from the IdP's userinfo endpoint with the caller's own token, from `OIDC_USERINFO_URL`, which bootstrap now writes to `apis.env` from discovery; a userinfo refusal is `401 invalid_token`, an unreachable userinfo is `502 userinfo_unavailable`, and the row is written only from what the IdP answered. The wire format is snake_case JSON (`id`, `name`, `is_personal`, `policy`), defined once with zod on `@auth-stack/tenancy/client` (`organizationWire`, `provisionWire`, `organizationsWire`, `toWire`, `fromWire`) so the API answers and the client parses from the same schema; the scope vocabulary is `TENANCY_API_SCOPES` on the same subpath. Statuses: `TenancyError` `not_found`, `forbidden`, `personal_organization` map to `404`, `403`, `409`; an organization ID that is not a UUID is `404` like one the caller may not see; Fastify's own verdicts on a request (`415`, `413`) keep their status with a body of `{ "error": "bad_request" }`; anything else is `500 { "error": "internal" }` with the cause in the log only. The HTTP client caches `getOrganization` answers, found or not, per user and organization for a minute, deduplicating concurrent asks, and throws `TenancyClientError` (status, code) on any answer outside the contract. Bootstrap registers the API application with the private-key JWT auth method (no client secret exists; the APIs hold no identity of their own in phase 1) and reconciles it like the OIDC application, writes the two grants with TOUCH keyed by dashboard-web's client ID, and keeps its SpiceDB channel open through the run, since the grants need the client ID the Zitadel steps return. Tests: route tests over an in-memory service with tokens from the fake OP and a fake userinfo (unit), and the client contract (`describeTenancyClientContract` on the new subpath `@auth-stack/tenancy/testing`) run by the package's integration test over the in-process client and by the API's integration test over the HTTP client, which reaches the app through Fastify's `inject` with the real service on `it_tenancy_api` and the real SpiceDB-backed resolver, with grants written for a client of that run. Run paths: the app is bundled with esbuild like bootstrap (14.4 MB with the inline source map, Fastify and Drizzle included; pino's default destination needs no worker file), its image is `node:alpine` plus that file and an entrypoint that sources `/config/apis.env`, the compose service is in the `apps` profile with no published port (reached by service name; `dashboard-web` depends on it being healthy), and under Tilt it runs on the host with `tsx watch` (a new devDependency: Node's own type stripping cannot follow the workspace's extensionless relative imports), as a `host_app` resource that sources `apis.env` and probes `/health`. The Tiltfile reads the committed `.env` (`STACK_ENV`) and exports to each host-run app the keys its compose service gets, with the hosts that differ outside the compose network replaced, so the values are not copied into the Tiltfile. Verified: lint, type-check, Prettier, 122 unit tests (15 new), 52 integration tests, compose config with every profile, bootstrap against the running stack (`tenancy-api` `created`, then `unchanged`; the grants readable with `zed`), every route with bob's real token against the host bundle, the `tsx` dev server, and the container from inside the compose network (where a `wget --post-data` request surfaced Fastify's `415` falling into the `500` catch-all, fixed above), the mirror row and the `organization#admin` relationship written, no token in any log line; then the reviewer path's `docker compose --profile apps up -d --wait --build` on the running volumes returned 0 with `tenancy-api` and `dashboard-web` healthy in that order, and the Tiltfile evaluates (`tilt alpha tiltfile-result`) with the new resource. Membership and policy routes remain ticket 17.

> **2026-10-18 (ticket 9):** The `host_app` serve command sourced the handoff file after exporting the host-side values, so a key in both (`TENANCY_API_URL`) kept the file's compose hostname on the host; nothing read it yet. Ticket 9 reverses the order: the file first, the exports last.

**Status:** Done (2026-10-18).

---

### Ticket 9 — `dashboard-web` app shell: login, logout, protected routes (2 h)

**Read first:** `docs/README.md` §4.4.

**Description:** Replace the spike page with the real app skeleton: `/` (public landing with "Log in"), `/auth/login`, `/auth/callback`, `/auth/logout` (a `POST` route handler guarded by `assertSameOrigin`), `/dashboard` (protected). `proxy.ts` redirects unauthenticated requests under `/dashboard` to `/auth/login`. A `getCurrentUser()` server helper reads the session once per request. Minimal CSS, no component library. Refines the Dockerfile, compose service, and entrypoint from ticket 3.

**Acceptance criteria:** log in as Alice, see "Welcome, Alice" on `/dashboard`; log out and `/dashboard` redirects to login; the Zitadel session is ended too (visiting Zitadel's login shows the form again).

> **2026-10-17 (after ticket 8):** The routes are one call each on `createNextAuth` from `@auth-stack/auth/next` (`login()`, `callback(request)`, `logout(request)`, which does the same-origin check itself; `currentSession()` for `getCurrentUser()`, `sessionFromRequest(request)` for `proxy.ts`), configured from `authOptionsFromEnv(process.env, { app: 'dashboard-web' })` and `createRedisSessionStore(new Redis(redisUrl), { prefix: 'dashboard-web' })`; the app adds `ioredis`. This ticket wires `SESSION_SECRET` and `REDIS_URL` from `.env` into the compose service and the Tiltfile (`REDIS_URL=redis://localhost:6379` on the host); `APP_URL` already comes from the handoff file. The spike's claims cookie and `lib/oidc.ts` go away.

> **2026-10-18 (after ticket 16):** The Tiltfile reads `.env` as `STACK_ENV` and each `host_app` exports the keys its compose service gets; this ticket adds `SESSION_SECRET: STACK_ENV['SESSION_SECRET']` and `REDIS_URL: 'redis://localhost:6379'` to the `dashboard-web` resource, and the two variables to the compose service.

> **2026-10-18 (deviations):** Built as specified, with these differences. The routes are the one-call wrappers of the note above, on a `createNextAuth` built on first use and kept on `globalThis` (`lib/auth.ts`): `next build` evaluates the route modules and the layout with no configuration, so nothing reads the environment when a module loads, and the root layout declares every page dynamic (`dynamic = 'force-dynamic'`), since every page reads the session; the build prerenders nothing and the image build needs no handoff file. `getCurrentUser()` is React's `cache` over `currentSession()` and returns `sub`, `email`, and `name` only, never the tokens. The root layout shows the name and the logout form (a plain `POST` form, so the browser sends `Origin` and `assertSameOrigin` passes without JavaScript) or the login link; the landing page links to the dashboard when a session exists. `proxy.ts` redirects to `/auth/login` built on `APP_URL`, never on the request's host (ticket 8's finding), and `/dashboard` checks again. The greeting is the ID token's `name` (`Welcome, Alice Adams`); `given_name` is not kept in the session. The Dockerfile takes the manifests-first layout of `apps/tenancy-api`. The Tiltfile's `host_app` sourced the handoff file after the exports, so the file's `TENANCY_API_URL` (`tenancy-api:4001`) overrode the host value; the order is now file first, exports last, which the two new keys do not need but ticket 10 does. `openid-client` leaves the app's dependencies (it is `packages/auth`'s); `ioredis` joins. No app tests: the binding is covered in `packages/auth`, and the browser flow is ticket 13. Verified: lint, type-check, Prettier, 123 unit tests, `next build` with no configuration set, the compose file with every profile, the Tiltfile evaluation, then the whole flow with a real Zitadel login of `alice` (the session API in place of the login form, as in ticket 16) against the host dev server and against the container from `docker compose --profile apps up -d --wait --build`: the gate without a session, the stash and session cookie attributes, the generic failure on a replayed callback, the greeting, the cross-origin logout refused, the logout's `303` to `end_session` with `id_token_hint` and the registered post-logout URI, the old cookie refused afterwards, no token in any log line, no key left in Redis. Zitadel answers that end-session request with a redirect straight to the post-logout URI. The browser half of the acceptance criteria, which no script without a Login V2 cookie can observe, was checked by the maintainer on 2026-10-18: after logging out, a direct `/dashboard` goes through `/auth/login` to Zitadel's login-name form rather than to a silent sign-in, so the IdP session ended with ours.

**Status:** Done (2026-10-18).

---

### Ticket 10 — Just-in-time provisioning and personal workspace (2 h)

**Read first:** `docs/README.md` §6.4.

**Description:** In the callback, after session creation, two idempotent calls (§6.4). First `TenancyClient.provisionUser()` over HTTP to `tenancy-api` with the user's access token; `tenancy-api` takes `sub` from the token and, on the first call for that `sub`, fetches `email` and `name` from Zitadel's userinfo endpoint with the same token (verified by the IdP, no trust in the caller's body), inserts the `users` row, creates the personal organization (absent-check on the partial unique index), and writes its tuples; it returns the organization. Second, the BFF calls the documents domain's `ensurePersonalProject(user, orgId)` (in-process in phase 1; `POST /organizations/:id/personal-project` on `dashboard-api` from phase 2), which creates the "Personal" project and the "Welcome" document and writes their tuples. Both steps key on absence of the thing they create, not on the `users` row, so seeded users (ticket 12) get their personal workspace on first login too. ZedTokens are not stored until ticket 21. Idempotent and race-safe per §6.4: `INSERT ... ON CONFLICT DO NOTHING` on `users.id` with a read of the winner, the partial unique index on `organizations (owner_id) WHERE is_personal`, and `TOUCH` semantics on the relationship writes; the call runs on every login callback and returns the existing user after the first.

**Tests:** integration test: a new `sub` gets exactly one personal organization, one project, one document, and `check(document, edit, user)` allows; a second call creates nothing; ten concurrent first calls for the same `sub` leave exactly one of each.

> **2026-10-17 (correction, found in ticket 6):** "ZedTokens are not stored until ticket 21" above is stale since the consistency correction of the same date (`docs/README.md` §7.3; ticket 7): `ensurePersonalProject` stores the relationship write's token on the "Welcome" document from phase 1, like every content write.

> **2026-10-17:** Per the preamble rule added in ticket 6, this ticket writes or updates the README of every package it implements or changes (`packages/tenancy`, `packages/documents`) in the same PR.

> **2026-10-17 (after ticket 7):** `provisionUser(claims)` and `ensurePersonalProject(user, organizationId)` exist in the packages since ticket 7, idempotent and race-safe as described, with the integration tests above (concurrency included) already passing there; this ticket wires the callback, `tenancy-api`'s userinfo fetch, and the in-process call.

> **2026-10-18 (after ticket 16):** The API half is done: `POST /me/provision` fetches userinfo on the first call for a `sub` (ticket 16's deviations note), and the HTTP `TenancyClient` (`httpTenancyClientFromEnv()`, `TENANCY_API_URL` in `dashboard-web.env`) is what the callback calls. What remains here is the callback wiring in `dashboard-web` after ticket 9 (the two calls after session creation), the in-process `ensurePersonalProject` call, and the end-to-end integration test above.

> **2026-10-18 (after ticket 9):** The callback is `auth().callback(request)` on the `next` binding, which creates the session and redirects in one call, so the two provisioning calls need a hook in `packages/auth` between session creation and the redirect; this ticket decides its shape (and what a failed provisioning does to the login). On the host, `TENANCY_API_URL` now reaches `localhost:4001` (the Tiltfile order corrected in ticket 9).

> **2026-10-18 (deviations):** Built as the notes above left it, with these decisions. The hook is `onLogin(session)` on `createNextAuth` (`@auth-stack/auth/next`): it runs on every completed login with the stored session, before the session cookie is set; a throw deletes the session again, clears the stash, answers the generic failed response, and logs `auth.login_failed` with the new `AuthErrorCode` `login_hook_failed` and the error's message. A failed provisioning therefore fails the login (the maintainer's choice; the alternative, letting the user in without a workspace, was rejected), and the next login runs both calls again. `dashboard-web` composes the two calls in `lib/provisioning.ts` (`createWorkspaceProvisioner`): `TenancyClient.provisionUser` over HTTP with the session's access token, then `ensurePersonalProject` on the in-process documents service of `lib/services.ts` (`@auth-stack/documents` over `DOCUMENTS_DATABASE_URL` and `@auth-stack/authz`, with the HTTP tenancy client for organization names), built on first use like the auth instance; it logs one `workspace.provisioned` line (sub, organization and project IDs, which of them this login created) and nothing on a repeat. The compose service gains `DOCUMENTS_DATABASE_URL` and `SPICEDB_*` with `depends_on` `postgres` and `spicedb`, the Tilt resource the host-side values and a dependency on the host `tenancy-api` (a `deps` parameter of `host_app`), since a login before it answers would fail; the documents, authz, db-core, and tenancy packages join the app's dependencies (tenancy through its `client` subpath only). Tests, per the maintainer: the app's boundary is the app, so the composition is unit-tested with both services faked (order, arguments, the organization ID flowing from tenancy to documents, failures propagating, no token in the log fields), the hook with the fake OP (the session exists while it runs; a throw leaves no session, no cookie, the generic response, the logged code), and the integration tests of the **Tests** line above remain where ticket 7 and 16 put them, in the packages that own the writes; no new integration test. Neither `packages/tenancy` nor `packages/documents` changed, so their READMEs did not; `packages/auth`'s did. `docs/README.md` §6.4 is corrected in place rather than annotated: its sentence about storing the write's ZedToken in the session was stale since the §7.3 correction, and the paragraph now states how the BFF runs the calls. Verified live against the rebuilt container and the host process: a seeded user's first login creates one `users` row, one personal organization, one "Personal" project, and one "Welcome" document carrying a token, `document#edit` allows the user, and the second login creates nothing and logs nothing; with `tenancy-api` stopped, the callback answers `400` with no session cookie and the stash cleared, and the log line carries `login_hook_failed` and no token.

**Status:** Done (2026-10-18).

---

### Ticket 11 — Dashboard with the three states, and the edit flow with server-side enforcement (3 h)

**Read first:** `docs/README.md` §6.5.

**Description:**

- `packages/documents` services: `listVisibleDocuments(user, consistency)` (one `lookupResources(document, view, user)` → join IDs to `documents` rows with project names and, through `TenancyClient`, organization names → one `bulkCheck` of `edit` over the rows; `consistency` is `fullyConsistent` throughout phase 1 and becomes the §7.3 levels in ticket 21), `getDocumentForEdit(user, id)` (load the row, check `edit` at `atLeastAsFresh(row.zedtoken)`; `view`-only → `403`; neither → `404`), `updateDocument(user, id, values)` (check `edit` at `fullyConsistent`, then in one `UPDATE` store `value_1`, `value_2` (zod: strings of 1–200 characters), `updated_by`, and the check's returned ZedToken as `zedtoken`; §7.3).
- `/dashboard` renders one row per document grouped by organization and project, with "Edit" or a disabled "Read-only" marker.
- `/documents/[id]/edit` renders the form (server component) that posts to the route handler `POST /documents/[id]/edit` guarded by `assertSameOrigin` (§9), which validates input with zod, calls `updateDocument`, and redirects back with a flash message. Route handlers rather than Server Actions, so that enforcement is a visible HTTP endpoint a reviewer can replay with `curl`. Forbidden and not-found states render proper pages.

**Acceptance criteria:** with the seeded users (ticket 12): Alice edits everything; Bob edits Marketing and never sees Finance; Carol edits Launch plan, sees Budget read-only, never sees Payroll; a `curl` `POST` to Budget's edit route with Carol's cookie returns `403`; to Payroll returns `404`.

> **2026-10-17 (after ticket 7):** The three `packages/documents` services of the first bullet exist since ticket 7 with the consistency levels named here and `DocumentsError` codes for `403` and `404`; this ticket builds the pages and the route handler on them.

> **2026-10-18 (deviations):** Built on the ticket 7 services, with these differences. The save route is `POST /documents/[id]`, not `POST /documents/[id]/edit`: Next.js does not allow a `page.tsx` and a `route.ts` in one segment, so the form page keeps `/documents/[id]/edit` and posts one segment up, which mirrors the per-document write `dashboard-api` gets in phase 2. A successful save answers `303` to `/dashboard?saved=<id>`, where the listing shows the flash (`Saved “<name>”.`, the name taken from the listing, never from the query); rejected values (the domain's zod schema, run in the handler before anything is looked up) answer `303` to the form with `?error=values`, and a body that is not a form `400`. The handler checks the origin first, then the session, and maps the domain's `forbidden` to `403` and `not_found` to `404` with plain-text bodies, since those answers exist for a replayed `curl`, which must carry `Origin: http://dashboard.localtest.me:3000` or `Sec-Fetch-Site: same-origin`, or every POST answers `403`. The forbidden state of the edit page is a read-only page answered with `200`: a `403` from a page needs `forbidden()` behind `experimental.authInterrupts`, which the maintainer chose not to enable; the not-found state is `notFound()` with `app/not-found.tsx`, a true `404`. The listing runs at `fullyConsistent`, as this ticket says, until ticket 21. `proxy.ts` gates `/documents` too and answers a request without a session with `303` for anything but `GET`, so a form posted after the session ended does not repeat its POST on the login. The handler is built with its dependencies (`lib/save-document.ts`) and unit-tested with them faked (origin, session, validation, both denials, success, the log line without a token); the dashboard grouping is a pure function with a test; the pages are thin and were checked live. Two findings in `packages/documents`: a malformed ID reached the `uuid` column and answered with a database error, now `not_found`; and Turbopack gives the route handler and the server components separate copies of the package while the service is built once on `globalThis`, so `instanceof DocumentsError` failed across them and the save route answered `500`; `isDocumentsError` tests the name and the code instead. The acceptance criteria name the ticket 12 seeds, which do not exist yet; verified against the container with the personal workspaces instead: alice's dashboard lists "Welcome" under Personal / Personal with "Edit", the form shows the values, the save redirects with the flash and the form shows the new values; every refusal (another origin, no origin header, an empty and a 201-character value, a JSON body, a malformed and an unknown ID, no session for the page and for the POST); bob's first login provisioned his workspace, his dashboard shows only his document, and alice's answers `404` to his POST and his GET; with `document:<id>#viewer@user:<bob>` written through `pnpm authz:zed`, his POST answers `403`, his dashboard lists the document read-only, the edit page shows the read-only page, and after the tuple's removal the POST is `404` again; the container log holds no error and no token. Checks: lint, Prettier, type-check, 143 unit tests, 52 integration tests, `next build` with no configuration, gitleaks. Found and not fixed here: the design has no way to create a document (no creation permission below the organization in the schema, no service, no form); ticket 19b adds it.

> **2026-10-18 (after ticket 12):** The acceptance criteria hold with the seeded users: each user's dashboard is the §6.3 table plus their personal "Welcome"; Carol's `POST` to "Budget" answers `403` and to "Payroll" `404`, Bob's to "Payroll" `404`, and the same two through the edit page (the read-only page, the `404` page); Alice edits "Payroll". Asserted through the services in the documents package's integration test and live through the browser flow (ticket 12's note).

**Status:** Done (2026-10-18).

---

### Ticket 12 — Seeds: Acme organization, projects, documents, relationships (1.5 h)

**Read first:** `docs/README.md` §6.3.

**Description:** Bootstrap gains a seeding step after migrations and Zitadel users exist: through `packages/tenancy`, the `users` mirror rows for Alice, Bob, Carol (IDs from `seed.json`) and the Acme organization (`policy` `{}`); through `packages/documents`, the Marketing and Finance projects and the three documents; the relationship tuples from §6.3 (organization level by tenancy, project and document level by documents), storing the final relationship write's ZedToken on each seeded document. Primary keys are UUIDs; the seeds use fixed UUID constants so reruns match, and the names in §6.3 (`acme`, `marketing`, `launch-plan`) are labels, not identifiers. Personal workspaces are not seeded; each user gets one on first login (ticket 10). Idempotent (match by the fixed IDs, skip if present).

**Acceptance criteria:** fresh stack → log in as each seeded user → the §6.3 dashboard table holds exactly for Acme, plus one personal "Welcome" document per user.

> **2026-10-18 (deviations):** Built as described, with these decisions (the maintainer's, recorded in `docs/README.md` §12). The seed logic is two entry points in the packages that own the writes, `seedOrganization` (`@auth-stack/tenancy`) and `seedDocuments` (`@auth-stack/documents`), each taking every ID and `sub` as a parameter and writing in one transaction: rows with `ON CONFLICT DO NOTHING` on the fixed ID, every relationship TOUCHed, the write's token returned by tenancy and stored by documents on every seeded document; bootstrap (`apps/bootstrap/src/seed.ts`) holds the `5eed0000-…` constants and the §6.3 roles, builds both seeds from the Zitadel IDs its own user step returned (not from `seed.json`), runs tenancy then documents after the user step, and logs one line per domain with the IDs it created. "Skip if present" applies to rows only: a re-run never changes a value, a writer, or a policy, but puts the roles and shares back and moves the tokens forward, so bootstrap's re-run on every `up`, `tilt up`, and package save under Tilt neither wipes an edit session nor leaves a share removed by hand, or a `sub` changed by a Zitadel-only reset, unrepaired. The `users` mirror rows carry `Alice Adams`, `Bob Baker`, `Carol Clark`, so a seeded user's first login skips `tenancy-api`'s userinfo fetch; a user who already had a row from an earlier login keeps it. `seed.json` gained the organization's ID and, by label, the projects' and documents', next to the users' Zitadel IDs. Tests: each package's integration test seeds a scenario of its own under random IDs (reruns create nothing, an edit between runs survives while the token moves, a share deleted by hand is back after the next run and visible to the edit page's read); the documents test asserts the full §6.3 table through `listVisibleDocuments` and `getDocumentForEdit`; bootstrap's unit tests cover the scenario's shape and `seed.json`. Verified live under Tilt: the first run created Acme, the two projects, the three documents, and Carol's mirror row (Alice and Bob had rows from earlier logins); the second run created nothing; the tuples read back through `pnpm authz:zed` are exactly §6.3's; the browser flow logged in as all three (Carol's first login provisioned her personal workspace next to Acme), each dashboard was the §6.3 table plus "Welcome", Carol's `POST` to "Budget" answered `403` and to "Payroll" `404`, Bob's to "Payroll" `404`, Alice edited "Payroll", and a bootstrap run after those edits kept every value and moved every token. Known limit, not fixed: a Zitadel-only volume reset leaves the old `sub`s' tuples behind. Checks: lint, Prettier, type-check, 146 unit tests, 58 integration tests, gitleaks.

**Status:** Done (2026-10-18).

---

### Ticket 13 — Playwright end-to-end: login and edit for the three users (2 h)

**Read first:** `docs/README.md` §6.3.

**Description:** `apps/dashboard-web/e2e/` with one spec per seeded user walking login → dashboard → edit (or read-only) → save → logout, plus one spec for the forbidden `POST`. Runs against the compose stack; CI job starts the stack with `--wait`, runs Playwright, uploads the trace on failure.

**Acceptance criteria:** green locally and in CI.

> **2026-10-18 (deviations):** Built as described, with these decisions (the maintainer's, recorded in `docs/README.md` §12). `@playwright/test` is a root devDependency like Jest; the config is `apps/dashboard-web/playwright.config.ts` (Chromium only, trace kept on failure, one worker and one retry on CI, the HTML report never opened by itself), the specs are `apps/dashboard-web/e2e/*.spec.ts` (a name Jest's unit project does not match), and the root `test:e2e` placeholder of ticket 1 now runs them. The suite starts nothing: it expects the apps at `E2E_BASE_URL` (default `http://dashboard.localtest.me:3000`, the compose stack with the apps profile or Tilt) and reads `.local/config/seed.json` for the users and the document IDs and the root `.env` for the seeded password; a global setup fails with a message naming what to start when either is missing. One spec per user: Zitadel's login-name and password pages, the dashboard greeting and the exact §6.3 table plus the personal "Welcome", an edit of one document per user (Alice "Payroll", Bob "Budget", Carol "Launch plan", so parallel specs never write the same row) that replaces the second value, checks the dashboard's confirmation and the value read back, and restores the original in the same test, Bob's `404` on the Finance document and Carol's read-only page on "Budget", then "Log out", proven by a direct `/dashboard` reaching Zitadel's login-name form rather than a silent sign-in. A fourth spec posts from Carol's browser session with the session cookie and an `Origin`: `403` on "Budget", `404` on "Payroll", `403` cross-origin on "Launch plan". The suite is excluded from the image build context (`.dockerignore`), where the app's tsconfig would type-check it, and its output directories from markdownlint, which would otherwise lint the `error-context.md` Playwright writes per failed test. CI gained an `e2e` job: the full stack with the apps profile built on the runner, `playwright install --with-deps chromium`, the suite, the report and traces uploaded on failure, `down -v` always. The root README's Development section gained a "Tests" block that says what each of the three suites needs running and how to open the report. Verified locally against the compose stack: four tests green in four passing runs, one of them with `CI=1` (one worker, 10 s), the seeded values back to their documented starting values after each run, the image build unchanged with the suite excluded, actionlint clean. Green in CI is the maintainer's to observe after the push. Checks: lint, Prettier, type-check, 146 unit tests (unchanged: Jest matches no spec), gitleaks.

**Status:** Done (2026-10-18).

---

### Ticket 14 — Root README v1: run instructions, architecture, trade-offs 📝 docs (2 h)

**Read first:** `docs/README.md` (all).

**Description:** Write the human-readable README: what this is, architecture diagram and a short tour of the repo, how to run (compose; Tilt), the seeded users table, how to try the three states, how authorization and consistency work in two paragraphs each, the security posture summary, **trade-offs, shortcuts, and gaps** (an explicit list, updated every phase), and **future work** (every unreached phase, from `docs/README.md` §11). Link to `docs/README.md` for the full design.

**Acceptance criteria:** a reader who has never seen the repo can run it and see the three states in under ten minutes following only the README. With ticket 14 merged, the submission is viable.

> **2026-10-15:** The "how to run" part is no longer this ticket's: the root README's **Development** section is kept current by every ticket that changes the local setup (rule in `CLAUDE.md`), starting with ticket 1. Ticket 14 reviews that section for a first-time reader rather than writing it.

**Status:** Open.

---

## Phase 2 — Services: dashboard-api, tenancy-web, single sign-on and sign-out

### Ticket 19a — `dashboard-api` on Fastify (2 h)

**Read first:** `docs/README.md` §3.1, §6.5, §6.7.

**Description:** `apps/dashboard-api` exposing `GET /documents`, `GET /documents/:id` (checked at `at_least_as_fresh` with the row's token), `PUT /documents/:id` (checked at `fully_consistent`, token stored with the content), `PUT /documents/:id/shares` (member IDs only, `document#share`, token stored on the row), `POST /organizations/:id/personal-project` over `packages/documents`, on the bearer plugin and scope gate from ticket 15 (`documents:read` on `GET`, `documents:write` on `PUT`). Organization data through the HTTP `TenancyClient`. Health endpoint, Dockerfile, compose service; bootstrap registers the API application and its scopes.

**Tests:** integration test for the routes with a token minted by a test signer, including the `403`/`404` cases of §6.5.

> **2026-10-18 (after ticket 16):** Follow `apps/tenancy-api`: `buildApp(deps)` over the service with the error handler's status mapping, the esbuild `build.mjs`, the Dockerfile and entrypoint sourcing `apis.env`, the compose service without a published port, and a `host_app(..., config='apis', path='/health')` Tilt resource; in bootstrap, one more `ensureApiApp` and the documents scopes added to `scopeGrants`. The HTTP `TenancyClient` of ticket 16 is what this API uses for organization data.

> **2026-10-18 (deviations):** Built as specified, in the shape the note above names, with these additions. The shares route had nothing to stand on (the service had no share method and `packages/authz` could not read relationships), so, at the maintainer's choice, both were built: `readRelationships(filter, consistency)` on `packages/authz`, and `setDocumentShares(user, id, { editors, viewers })` on `packages/documents`, which replaces the document's direct shares as one set: `document#share` at full consistency (`403` for a caller who may view, `404` otherwise), every grantee checked as `organization#view` on the owning organization (a non-member, known or not, is the new code `not_a_member`, answered `400`), the shares that exist read fully consistent, the difference written in one atomic call (TOUCH for every listed user, DELETE for every other), and the write's token stored on the row without touching its values or writer; an unchanged set writes nothing and stores the check's token. The wire format and `DOCUMENTS_API_SCOPES` live on the new subpath `@auth-stack/documents/client`, mirroring tenancy's: snake_case JSON (`value_1`, `value_2`, `project_id`, `can_edit`, `updated_at` as ISO strings, `organization.name` null when tenancy hides it), never the `zedtoken`; the request bodies (`{ value_1, value_2 }`, `{ editors, viewers }`) are checked for shape there and for content by the service, and a `ZodError` from either is `400 invalid_input`. `VisibleDocument` moved to that subpath (the root re-exports it). `GET /documents/:id` is the edit page's read (`403` for a viewer), as §7.3's table and ticket 19 expect. The `:id` of the personal-project route is checked as a UUID in the route (`404` otherwise), the document routes leave it to the service, which already does. Tests: 15 route tests over an in-memory service with the fake OP (unit), 2 over the real service on `it_dashboard_api` with the compose SpiceDB and a fake tenancy client (the integration job starts no apps), covering the three states as statuses, the share action, member IDs only, and the workspace; 3 new service tests for shares and 1 for `readRelationships`. Verified: lint, Prettier, type-check, 174 unit tests, 64 integration tests, the 4 Playwright tests against the rebuilt apps, compose config with every profile, the Tiltfile (`tilt alpha tiltfile-result`), the image build (14.4 MB bundle), `docker compose --profile apps up -d --wait --build` on the running volumes with `dashboard-api` healthy, bootstrap logging the application `created` then `unchanged` and four grants, and from inside the container `/health` without a token, `401 Bearer` without one on `/documents`, `401 invalid_token` for a token signed by a key the issuer does not know (the JWKS fetched through the public hostname), with no token in any log line. Nothing calls the API until ticket 19; no URL is handed to the BFF yet.

**Status:** Done (2026-10-18).

---

### Ticket 19b — Create a document in a project (1 h)

**Read first:** `docs/README.md` §6.2, §6.5, §7.3.

**Description:** A deficiency found in the design while implementing ticket 11: nothing creates a document after the ticket 12 seeds and the "Welcome" document of provisioning, and the schema has no creation permission below the organization (`organization#create_project` exists, `project` has nothing). The fix, in the shape the existing pieces have:

- Schema: `project` gains `permission create_document = edit` (`packages/authz`), one line to widen later, for example to let viewers propose documents.
- `packages/documents`: `createDocument(user, projectId, { name, value1, value2 })` (zod: `name` a string of 1–200 characters, the values as in `updateDocument`) checks `project#create_document` at `fullyConsistent` (`project#view` allowed → `403`, otherwise → `404`, the §6.5 rule), then in one transaction inserts the row and writes `document:<id>#project@project:<id>`, storing the relationship write's token on the row, the shape of `ensurePersonalProject`.
- `dashboard-api`: `POST /projects/:id/documents` (bearer, the documents write scope) over the service, answering `201` with the document.
- `dashboard-web`: a "New document" form under each project heading of the dashboard where the user may create (one bulk check of `project#create_document` over the listed projects, at the listing's consistency), posting to the route handler `POST /projects/[id]/documents` guarded by `assertSameOrigin` (§9), which validates with zod and calls the API the way ticket 19 does, then redirects to the dashboard with the flash of ticket 11. If this ticket lands before ticket 19, the handler calls the service in-process as ticket 11 does, and ticket 19 moves it with the rest.

**Tests:** the service's integration test (an editor creates, a viewer gets `403`, a non-member `404`, the token stored); the API route in `dashboard-api`'s integration test; the BFF handler's unit test with the client faked.

**Acceptance criteria:** with the seeded users: Alice creates a document in Finance; Bob creates one in Marketing and gets `404` for Finance; Carol gets `403` for Marketing; each new document appears on the dashboards with the states of §6.3 (an organization admin edits it, a project viewer sees it read-only).

**Status:** Open.

---

### Ticket 17 — `tenancy-web`: organizations, members, policy (2.5 h)

**Read first:** `docs/README.md` §3.1, §6.8, §9.1.

**Description:** `tenancy-api` gains `GET|PUT /organizations/:id/members` and `PUT /organizations/:id/policy` (`organization#administer`). A second Next.js app on `packages/auth` plus the `next` adapter, its own OIDC application and `backchannel_logout_uri` registered by bootstrap: `/organizations` (mine), `/organizations/[id]` (member list with role toggle and remove, for admins; read-only list for members, which is also the share picker's source; policy form: require MFA, maximum login age, required IdP). No add-member form: joining is by invitation (ticket 17a). Every action goes through `tenancy-api` with the user's token. Minimal UI; the point of the ticket is how little the second client contains, and the README says so.

**Acceptance criteria:** Alice demotes Bob to member and back; a member cannot open the policy form; Carol sees the member list but no controls.

> **2026-10-18 (as built):** The acceptance criterion is read against the seed, where Bob starts as a member: Alice promotes him and demotes him back, and the suite leaves the scenario as seeded. Three choices by the maintainer, recorded in `docs/README.md` §12: `PUT /organizations/:id/members` changes or removes a current member only (`400 not_a_member` otherwise; a first role comes from an invitation or the seed), the last administrator cannot be demoted or removed (`409 last_admin`), and `tenancy-web`'s login hook provisions through tenancy only until ticket 19's HTTP documents client exists (§6.4 rewritten). The share picker's source is `GET /organizations/:id/members`, visible to every member. Verified: 192 unit tests (18 new: five route tests on `tenancy-api`, the two write handlers and the login hook of `tenancy-web`, the client's writes), 71 integration tests (the service's member list and membership rules, the client contract over both implementations with three new cases), 6 Playwright tests (the 4 of ticket 13 plus Alice and Carol on `tenancy-web`), the stack up with `tenancy-web` healthy, bootstrap `created` then `unchanged` for the second application with six scope grants.

**Status:** Done (2026-10-18).

---

### Ticket 17a — Invitations with a uniform response (2 h, optional: only if Saturday allows)

**Read first:** `docs/README.md` §5.1 (`invitations`), §6.8.

**Description:** `tenancy-api`: `POST /organizations/:id/invitations` (`organization#administer`; stores the row with a hashed random token and a 7-day expiry; sends the email through SMTP with `nodemailer`; always answers `202` with the same body), `GET /invitations/:token` and `POST /invitations/:token/accept` (signed-in user whose email matches; writes the tuple at `fully_consistent`; marks accepted; expired, used, and unknown tokens all answer the same `404`). `tenancy-web`: an invite form on the organization page for admins and an `/invitations/[token]` accept page that sends an unauthenticated visitor through login first. Rate limits per §6.8: per inviting user and per organization through `@fastify/rate-limit`, and a per-address cooldown enforced from the latest invitation row for that email; `429` on breach, uniform `202` otherwise.

**Acceptance criteria:** Alice invites an unknown email and an existing account's email and sees the identical response; both emails appear in Mailpit; following the link as the existing account joins Acme; a second use of the link fails like an unknown one.

**Status:** Open.

---

### Ticket 17b — TLS at Traefik for Zitadel, so the IdP session survives (2 h)

**Read first:** `docs/README.md` §4.2, §4.3, §9 (Transport).

**Description:** Found while reviewing ticket 17: Zitadel's Login V2 stores its own session in a `sessions` cookie that it sets with the `Secure` attribute (`secure: NODE_ENV === "production"` in the login app, and the image fixes `NODE_ENV` in its bundled server, so no setting turns it off). Browsers refuse a `Secure` cookie over plain HTTP on any host but `localhost`, so on `http://auth.localtest.me:8080` the cookie is never stored: each login completes (the login UI carries the session through the flow by URL), but the next authorization request from any app starts at the login-name page again. No IdP session survives, so there is no single sign-on, and ticket 20 cannot pass. The fix is the one §9 already names for any real deployment: TLS terminates at Traefik. A one-shot `tls` container (`openssl`, in the shape of `spicedb-migrate`) generates a development CA and a certificate for `auth.localtest.me` into `./.local/tls/` (gitignored, next to `.local/config/`) at first start and exits, idempotent, so the zero-step start of §9 stays; Traefik gets a `websecure` entrypoint serving it through the file provider, published as the one public port of Zitadel (`https://auth.localtest.me:8443`; the plain entrypoint goes away, so there is one issuer), and Zitadel runs with `ZITADEL_EXTERNALSECURE=true` and the matching port, the login container forwarding `X-Forwarded-Proto: https`. Everything that calls Zitadel trusts the CA: the app and bootstrap containers and the Tilt-run processes through `NODE_EXTRA_CA_CERTS` pointing at the CA file, the Playwright suites through the same variable for the Node side and `ignoreHTTPSErrors` for the browser. The apps' own URLs stay plain HTTP (the back-channel logout URIs included). The root README says how a reviewer imports the CA once, or clicks through the browser warning. `docs/README.md` §4.2, §4.3, §9 are rewritten in place for the HTTPS issuer and the decision log records what they said.

**Acceptance criteria:** From a clean state, `docker compose --profile apps up -d --wait --build` needs no manual step and bootstrap writes an `https://` issuer; log in on `tenancy-web`, open `dashboard-web`, click "Log in", and land on the dashboard without a prompt (the `sessions` cookie is stored, which the browser's cookie view shows); both end-to-end suites green locally and in CI; under Tilt the same.

> **2026-10-18:** Created from the finding above after ticket 17 was verified. The maintainer chose TLS at Traefik over the two alternatives weighed: a Chromium flag that treats the plain origin as secure (`--unsafely-treat-insecure-origin-as-secure`; Chromium only, and the reviewer path would depend on a browser flag), and Zitadel on `localhost` (browsers treat it as a secure context, but §4.3's spike rejected that shape because the containers cannot reach the host by that name without a Host-header override in the OIDC client). Must precede ticket 18 as well as ticket 20: without one IdP session shared by the apps, each app's login creates its own Zitadel session with its own `sid`, so a sign-out on one app ends only that session and the back-channel logout token never names the other app's, which leaves ticket 18 nothing to prove.

> **2026-10-18 (built):** As described, with these particulars. The `tls` one-shot is `alpine/openssl` (pinned in `.env`) running `docker/tls/generate.sh`: ECDSA P-256 keys, a ten-year CA, an 825-day certificate (the longest macOS trusts) with `subjectAltName`, `serverAuth`, and `CA:FALSE`; the CA is created once and kept, the certificate reissued when it stops verifying or is within 30 days of expiry; `proxy` depends on it with `service_completed_successfully`, which is what lets `up -d --wait` accept an exited one-shot (the ticket 4 lesson). Traefik reads the certificate through its file provider from the same generated directory, watched, and the script writes `traefik.yml` last and atomically, so under Tilt, which starts `proxy` as soon as the `tls` container runs, a Traefik that came up first loads the certificate when the file appears (verified: the certificate Traefik served after `tilt up` on an empty `.local/tls/` was the one just generated); the health check is on an unpublished plain `ping` entrypoint, since the `healthcheck` subcommand speaks HTTP. The Node side of the Playwright suites needs no CA, contrary to the ticket text: nothing in them calls Zitadel from Node (the global setup fetches the app), so only `ignoreHTTPSErrors` was added. Zitadel's login UI and console send `Strict-Transport-Security`, so the README tells the reviewer to import the CA and says when clicking through the warning stops being possible. Verified on a fresh instance: `docker compose --profile apps up -d --wait --build` in 79 s with no manual step, bootstrap writing `OIDC_ISSUER=https://auth.localtest.me:8443`; Login V2's `sessions` cookie stored after a login; a login on `tenancy-web` followed by "Log in" on `dashboard-web` landing on the dashboard with no prompt; both suites green against compose; `docker compose up -d --wait` without a profile, the CI integration job's shape, exiting 0 with the one-shot exited; under Tilt, bootstrap `unchanged`, the host apps up, the `tenancy-web` suite green, and the `dashboard-web` suite three of four (below). Two findings. (1) The logout step of both suites asserted Zitadel's login-name form after a logout, which only ever passed because no IdP session existed; now `end_session` with the `id_token_hint` terminates the session and redirects straight back, and Login V2, which keeps the session ID in its cookie, lists the ended session on its account picker, where choosing it asks for the password. The helpers take the user's email and assert that. (2) Zitadel now delivers back-channel logout tokens to the apps' registered URIs on every logout (`POST /auth/backchannel-logout` answered `404` by both apps), so ticket 18 has its trigger. One acceptance criterion is not met in full: "under Tilt the same" fails for Bob's spec of the `dashboard-web` suite, where the not-found page for a document he may not see comes back from `next dev` as an empty error shell (status `404`, `<html id="__next_error__">`, no heading), while the standalone server, which compose and CI run, renders the page. The app's code is unchanged here and the page is plain HTTP, so this ticket is not the cause, but the suites had only ever been run against compose, so whether it fails on `main` under Tilt is inferred, not observed; whether it becomes a ticket is the maintainer's call.

**Status:** Done (2026-10-18).

---

### Ticket 18 — Back-channel logout sink in `packages/auth` (2 h)

**Read first:** `docs/README.md` §4.4 (step 6).

**Description:** `POST /auth/backchannel-logout` handler in the core with a `next` binding: validate the logout token (signature, `iss`, `aud`, `iat`, `exp`, `events`, `sid` or `sub`, no `nonce`), `deleteByLogoutToken({ sid, sub })`, `200` on success, `400` on an invalid token, never a redirect; mounted on `dashboard-web` and `tenancy-web` (their URIs were registered by tickets 4 and 17). Confirm empirically that a sign-out through `end_session` delivers the token inside compose, and whether admin session termination does too; record both as a dated note in §4.4.

**Tests:** unit tests with a signed fake logout token; integration test: logout in Zitadel removes the Redis session.

> **2026-10-17:** Per the preamble rule added in ticket 6, this ticket writes or updates the README of every package it implements or changes (`packages/auth`) in the same PR.

> **2026-10-17 (after ticket 8):** `deleteByLogoutToken({ sid, sub })` exists on both stores with the semantics of §4.4 (with `sid`, that IdP session's sessions, also matching `sub` when both are given; with `sub` alone, every session of the user; a mismatched pair deletes nothing), and the fake OP's `sign()` produces the test logout tokens. This ticket adds the token validation and the handler.

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

### Ticket 21 — Listings at `minimize_latency` and the New Enemy tests (2 h)

The per-row token and the write-path `fully_consistent` checks exist since phase 1 (tickets 7 and 11). This ticket completes `docs/README.md` §7.3: listings switch from `fullyConsistent` to `minimizeLatency`, and the README states that a listing may lag one's own write by a few seconds while content reads stay exact. A minimal share action in `dashboard-web` (pick a member of the organization, grant `document#viewer` or `#editor` through `PUT /documents/:id/shares`, which stores the write's token on the document) exists so the tests have a write to make. Integration tests: New Enemy case 2 (remove Bob, then edit the document; Bob's read with the row's token is denied while a `minimize_latency` check inside the window may still allow), and New Enemy case 1 (remove then create; the new document's token postdates the removal, so the read is denied).

> **2026-10-17:** Per the preamble rule added in ticket 6, this ticket writes or updates the README of every package it implements or changes (`packages/documents`, and `packages/authz` if the helpers change) in the same PR.

**Status:** Open.

### Ticket 22 — Decision audit log and per-organization audit page (2.5 h)

`authz_decisions` in tenancy, written at every enforcement point through a `recordDecision()` hook that posts asynchronously to `tenancy-api` (`POST /decisions`, buffered) using the posting API's own client-credentials token (scope `audit:write`, granted to each API's client by bootstrap: the one no-user call in scope); `/organizations/[id]/audit` page in `tenancy-web` for organization admins; retention note in the README.

> **2026-10-17:** Per the preamble rule added in ticket 6, this ticket writes or updates the README of every package it implements or changes (`packages/tenancy`) in the same PR.

**Status:** Open.

---

## Phase 4 — Hardening (stubs)

### Ticket 23 — CSRF tokens, security headers, CSP, rate limits (3 h)

Per-session synchronizer token in forms (the origin checks exist since phase 1); headers per `docs/README.md` §9 in `next.config.ts` and a Fastify hook; `@fastify/rate-limit` on mutations; a small token bucket on the callback route and the back-channel logout sink.

**Status:** Open.

### Ticket 24 — Authentication-context policies: `requireAuthContext` and the step-up flow (3 h)

`organizations.policy` (from tenancy, cached) honoured by the BFFs: `requireAuthContext({ maxAge, amr })` in `packages/auth` reads `auth_time` and `amr` from the session, produces the RFC 9470 challenge, and the web apps turn it into a re-authentication (`prompt=login`, `max_age`) and retry. The seeded Acme organization gets `policy.max_auth_age_seconds: 600` (policy is per organization, §5.1) so a reviewer who logged in more than ten minutes earlier sees a step-up on their next write; personal organizations keep `{}`. README section on where policies live (§9.1).

> **2026-10-17:** Per the preamble rule added in ticket 6, this ticket writes or updates the README of every package it implements or changes (`packages/auth`) in the same PR.

**Status:** Open.

### Ticket 25 — Test coverage pass and README trade-offs update (2 h)

Fill gaps in unit and integration coverage, `pnpm audit` in CI (non-blocking), refresh the trade-offs and gaps section.

**Status:** Open.

---

## Phase 5 — Comments domain: cross-domain access (stubs; only if time allows)

### Ticket 26 — Zitadel spike: RFC 9068 claims through Actions 🔬 spike (1.5 h, timeboxed)

Try a Zitadel Action that adds `auth_time` and `amr` to the JWT access token; record the outcome in `docs/README.md` §9.1, rewriting the section in place with a decision-log entry (if it works, ticket 28 enforces policies in the APIs; if not, the limitation stands).

**Status:** Open.

### Ticket 27 — `packages/comments` and `comments-api` (3 h)

Schema (§5.3, including `comments.zedtoken`) and migrations, `comments` database in compose, Fastify API with `GET /documents/:id/comments` and `POST /documents/:id/comments` (scopes `comments:read`, `comments:write`); `comment` definition in the SpiceDB schema; permission checks through `document->view`, `fully_consistent` on post with the token stored on the comment and `at_least_as_fresh(comment.zedtoken)` on read (§7.3); document title fetched from `dashboard-api` with the caller's access token (§6.6); bootstrap registers `comments-api` in the same project.

> **2026-10-17:** Per the preamble rule added in ticket 6, this ticket writes or updates the README of every package it implements or changes (`packages/comments`) in the same PR.

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

`kind` cluster, Kustomize manifests for every service, a `Tiltfile.k8s`, README section. Images for the manifests come from the release pipeline described in `docs/README.md` §10 (Changesets across packages and apps, per-app image workflows pushing `ghcr.io/<org>/<repo>/<app>:<version>` and tagging after a successful build), set up as the first step of this phase; until then `kind load` of locally built images is the fallback.

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
