# auth-stack-exercise

A reference IAM stack: OIDC login through a self-hosted Zitadel, fine-grained authorization with SpiceDB, and a small resource dashboard that only lets users edit what they are permitted to edit. TypeScript monorepo (Next.js, Fastify, shared packages); runs with `docker compose up`.

The full architecture, decisions, and phase plan are in [`docs/README.md`](docs/README.md); the work breakdown is in [`docs/TICKETS.md`](docs/TICKETS.md). Run instructions, the seeded users, and the trade-offs list are added to this file in ticket 14.

## Development

Tool versions are pinned in `mise.toml` (Node 22, pnpm 10, Tilt) and installed with [mise](https://mise.jdx.dev). On a fresh clone:

```sh
mise trust       # once per clone: allow mise to read mise.toml
mise install     # installs the pinned Node, pnpm, and Tilt
pnpm install     # installs the workspace
```

Checks, which are the same ones CI runs:

```sh
pnpm lint          # ESLint plus markdownlint
pnpm format:check  # Prettier (pnpm format rewrites)
pnpm type-check    # tsc --noEmit in every package
pnpm test          # unit tests (Jest), nothing running; the integration and end-to-end suites are under "Tests" below
pnpm authz:validate  # zed validate on packages/authz/schema.zed, in a container; needs Docker, not the stack
```

The stack is Docker Compose with committed development defaults in `.env` (insecure by design, local use only): Postgres, Zitadel with its login UI behind Traefik (HTTPS, with a certificate the stack issues itself; see below), SpiceDB, Redis, Mailpit, and the bootstrap container, which writes the SpiceDB schema, runs the service packages' database migrations (the packages own them; bootstrap only executes them, because the apps start after it), configures Zitadel (project, the two OIDC applications, the API applications, seeded users), grants each first-party client its API scopes in SpiceDB, seeds the Acme scenario below into the tenancy and documents databases and SpiceDB, writes the apps' configuration to `.local/config/` (gitignored), and exits. There are two ways to run the project, and they share the apps' ports, so run one at a time.

**Everything in compose**, the way to review the project. No setup step and no Node needed; the app images and the bootstrap image are built locally:

```sh
docker compose --profile apps up -d --wait --build   # about a minute from a clean state, plus the image builds; returns when every service is healthy
docker compose logs bootstrap                        # one JSON line per object (created, exists, updated, or unchanged), per migrated database, and per seeded domain
docker compose --profile apps down -v                # stop and wipe the volumes (fresh Zitadel instance and databases on the next up)
```

Zitadel is served over HTTPS at `https://auth.localtest.me:8443`, because its login keeps the sign-on session in a cookie that browsers store only on a secure origin. The first start generates a development certificate authority in `.local/tls/` (gitignored; it survives `down -v`) and a certificate signed by it, and every container and host process that calls Zitadel trusts that CA. Your browser does not, so import `.local/tls/ca.crt` once, as a trusted root for websites, to be rid of the warning: on macOS `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db .local/tls/ca.crt` (or drag the file into Keychain Access and trust it), which Safari and Chrome use; Firefox keeps its own store on every platform (`about:preferences#privacy`, View Certificates, Authorities, Import), as does Chrome on Linux (`chrome://certificate-manager`, Authorities, Import). Clicking through the browser's warning works too, as long as the CA was never trusted in that browser: Zitadel's login sends `Strict-Transport-Security`, which Chrome and Firefox ignore on a connection with certificate errors (RFC 6797 §8.1) but honour once they have seen the site with a trusted certificate, and from then on they offer no way past a warning on that host. Deleting `.local/` makes the next start generate a new CA, which has to be imported again.

**Tilt**, the developer loop: the infrastructure runs in compose, bootstrap runs as a step, and the apps and APIs run on the host with hot reload, each with the `.env` keys its compose service gets (the `Tiltfile` replaces the hosts that differ outside the compose network) and its `.local/config/<app>.env` (`apis.env` for an API). Run Tilt through mise so the apps start with the pinned pnpm:

```sh
mise exec -- tilt up   # or plain `tilt up` in a shell with mise activated; the UI is at http://localhost:10350
tilt down              # after stopping tilt up: removes the containers, keeps the volumes (--delete-volumes wipes them)
```

With either stack running, `pnpm db:migrate` applies every package's pending database migrations from the host (`packages/*/migrations`); bootstrap applies the same ones at every start, so this is for iterating on a schema without re-running it.

**Tests**, three suites, each named after what it needs running. CI runs all three (`.github/workflows/ci.yml`: `checks`, `integration`, `e2e`):

```sh
pnpm test                              # unit (Jest): nothing running
pnpm test:integration                  # integration (Jest, the *.integration.test.ts files): either stack above running; the tests reach the compose Postgres, SpiceDB, and Redis from the host with the defaults of .env; the two packages that own a database (tenancy, documents) each create and drop their own (it_<package>)
pnpm exec playwright install chromium  # once per Playwright version: the browser the end-to-end suite drives
pnpm test:e2e                          # end-to-end (Playwright): the apps running (compose with the apps profile, or Tilt); runs the two suites below in turn and leaves the seeded scenario as it was; the browser accepts Zitadel's development certificate (ignoreHTTPSErrors), so no CA import is needed
pnpm test:e2e:dashboard-web            # apps/dashboard-web/e2e: logs in as each seeded user through Zitadel's login page, checks the dashboard against the table below, edits one document and puts it back, logs out, and replays the forbidden POST
pnpm test:e2e:tenancy-web              # apps/tenancy-web/e2e: Alice promotes Bob and demotes him back, sets Acme's sign-in policy and clears it, is refused as the last administrator; Carol sees the member list with no controls and her crafted POSTs answer 403 and 404
pnpm exec playwright show-report apps/dashboard-web/playwright-report  # after a failure: the report, with the trace of every failed test (apps/tenancy-web/playwright-report for the other suite; CI uploads both as one artifact)
```

Bootstrap is idempotent: every `up` and every `tilt up` re-runs it, a second run creates nothing, and a changed application setting is updated in place. The seeded users (password `Password1!`, emails verified, no Mailpit step needed) and what each sees on the dashboard, from the Acme organization with its Marketing project ("Launch plan", "Budget") and Finance project ("Payroll"):

| User | Role in the seeded scenario | Dashboard |
| --- | --- | --- |
| `alice@example.com` | Acme admin | Every Acme document, all editable |
| `bob@example.com` | Acme member, Marketing editor | Marketing documents editable; Finance absent |
| `carol@example.com` | Acme member, Marketing viewer, "Launch plan" shared to her directly (the reviewer's user) | "Launch plan" editable, "Budget" read-only, Finance absent |

Each user also gets a personal workspace (a "Personal" organization and project with a "Welcome" document) on first login. The seeded rows have fixed IDs, listed with the users' Zitadel IDs in `.local/config/seed.json`; a re-run of bootstrap creates nothing, keeps every edited value, and puts the seeded roles and shares back, so the scenario survives an edit session and a removed share alike.

| What | Where |
| --- | --- |
| Zitadel login and console | `https://auth.localtest.me:8443` (`/ui/console`); admin `zitadel-admin@zitadel.auth.localtest.me` / `Password1!` |
| Mailpit (every email Zitadel sends) | `http://localhost:8025` |
| Postgres, Redis, SpiceDB from the host | `localhost:5432`, `localhost:6379`, `localhost:50051` (preshared key `dev-preshared-key`) |
| SpiceDB CLI | `pnpm authz:zed schema read` (runs `zed` in a container against the stack; prints the schema bootstrap wrote, `packages/authz/schema.zed`, with its doc comments) |

The apps, at the same addresses either way:

| App | Where |
| --- | --- |
| `dashboard-web` | `http://dashboard.localtest.me:3000`: "Log in" goes through Zitadel (any seeded user, or an account registered on Zitadel's login page) to `/dashboard`, the protected area (a request without a session is sent to the login); the first login creates the user's personal workspace (a "Personal" organization and project with a "Welcome" document), and a login whose provisioning fails is refused rather than left without one; "Log out" ends the session here and at Zitadel. `/dashboard` lists every document the user may view, grouped by organization and project, with "Edit" or "Read-only" decided by SpiceDB; `/documents/<id>/edit` saves through `POST /documents/<id>`, which enforces on the server: with the session cookie and `Origin: http://dashboard.localtest.me:3000`, a `curl` POST of `value1` and `value2` answers `303` for a document the user may edit, `403` for one they may only view, and `404` for one they may not see |
| `tenancy-web` | `http://tenancy.localtest.me:3001`: the second client, on the same `packages/auth` and its own OIDC application, so a user signed in to one app is signed in to the other through Zitadel's session: log in here, then open `dashboard-web` and click "Log in", and the dashboard appears with no prompt. `/organizations` lists the user's organizations; `/organizations/<id>` shows the member list to every member and, to an administrator of a shared organization, the "Make administrator", "Make member", and "Remove" buttons next to each row and the sign-in policy form (require MFA, maximum login age, required identity provider). Every change is a same-origin `POST` to `/organizations/<id>/members` or `/organizations/<id>/policy` that `tenancy-api` decides: with a member's session cookie and `Origin: http://tenancy.localtest.me:3001`, a `curl` POST answers `403`, and for an organization the user is not in, `404`. There is no add-member form: joining is by invitation (future work until ticket 17a), and the last administrator cannot be demoted or removed. The "Personal" organization has nothing to manage |
| `tenancy-api` | `http://localhost:4001` under Tilt, `tenancy-api:4001` inside compose (not published): `GET /health` is public; `POST /me/provision`, `GET /me/organizations`, `GET /organizations/:id`, `GET /organizations/:id/members`, `PUT /organizations/:id/members`, `PUT /organizations/:id/policy` need a bearer token of the project with the `tenancy:read` or `tenancy:write` scope, so they are exercised through the apps and the tests rather than a browser |
| `dashboard-api` | `http://localhost:4002` under Tilt, `dashboard-api:4002` inside compose (not published): `GET /health` is public; `GET /documents`, `GET /documents/:id`, `PUT /documents/:id`, `PUT /documents/:id/shares`, `POST /organizations/:id/personal-project` need a bearer token of the project with the `documents:read` or `documents:write` scope, and answer the three states as statuses (`200`, `403` for a document the user may only view, `404` for one they may not see). `dashboard-web` still runs the documents domain in-process; it switches to this API in ticket 19 |

`localtest.me` and its subdomains resolve to `127.0.0.1` in public DNS, so no hosts-file entry is needed. What each service is for, the ports, profiles, and shared volumes are in [`docker/README.md`](docker/README.md). Each package under `packages/` has a `README.md` on how to use it: [`auth`](packages/auth/README.md), [`authz`](packages/authz/README.md), [`client-scopes`](packages/client-scopes/README.md), [`db-core`](packages/db-core/README.md), [`tenancy`](packages/tenancy/README.md), [`documents`](packages/documents/README.md).
