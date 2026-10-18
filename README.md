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
pnpm test          # unit tests (Jest); test:integration needs the stack running (either way below) and is run by CI
pnpm authz:validate  # zed validate on packages/authz/schema.zed, in a container; needs Docker, not the stack
```

The stack is Docker Compose with committed development defaults in `.env` (insecure by design, local use only): Postgres, Zitadel with its login UI behind Traefik, SpiceDB, Redis, Mailpit, and the bootstrap container, which writes the SpiceDB schema, runs the service packages' database migrations (the packages own them; bootstrap only executes them, because the apps start after it), configures Zitadel (project, OIDC application, API application, seeded users), grants the first-party client its API scopes in SpiceDB, writes the apps' configuration to `.local/config/` (gitignored), and exits. There are two ways to run the project, and they share port 3000, so run one at a time.

**Everything in compose**, the way to review the project. No setup step and no Node needed; the app images and the bootstrap image are built locally:

```sh
docker compose --profile apps up -d --wait --build   # about a minute from a clean state, plus the image builds; returns when every service is healthy
docker compose logs bootstrap                        # one JSON line per object (created, exists, updated, or unchanged) and per migrated database
docker compose --profile apps down -v                # stop and wipe the volumes (fresh Zitadel instance and databases on the next up)
```

**Tilt**, the developer loop: the infrastructure runs in compose, bootstrap runs as a step, and the apps and APIs run on the host with hot reload, each with the `.env` keys its compose service gets (the `Tiltfile` replaces the hosts that differ outside the compose network) and its `.local/config/<app>.env` (`apis.env` for an API). Run Tilt through mise so the apps start with the pinned pnpm:

```sh
mise exec -- tilt up   # or plain `tilt up` in a shell with mise activated; the UI is at http://localhost:10350
tilt down              # after stopping tilt up: removes the containers, keeps the volumes (--delete-volumes wipes them)
```

With either stack running, `pnpm db:migrate` applies every package's pending database migrations from the host (`packages/*/migrations`); bootstrap applies the same ones at every start, so this is for iterating on a schema without re-running it.

Bootstrap is idempotent: every `up` and every `tilt up` re-runs it, a second run creates nothing, and a changed application setting is updated in place. The seeded users (password `Password1!`, emails verified, no Mailpit step needed):

| User | Role in the seeded scenario (from ticket 12) |
| --- | --- |
| `alice@example.com` | Acme admin: every document editable |
| `bob@example.com` | Acme member, Marketing editor |
| `carol@example.com` | Acme member, Marketing viewer, one document shared directly (the reviewer's user) |

| What | Where |
| --- | --- |
| Zitadel login and console | `http://auth.localtest.me:8080` (`/ui/console`); admin `zitadel-admin@zitadel.auth.localtest.me` / `Password1!` |
| Mailpit (every email Zitadel sends) | `http://localhost:8025` |
| Postgres, Redis, SpiceDB from the host | `localhost:5432`, `localhost:6379`, `localhost:50051` (preshared key `dev-preshared-key`) |
| SpiceDB CLI | `pnpm authz:zed schema read` (runs `zed` in a container against the stack; prints the schema bootstrap wrote, `packages/authz/schema.zed`, with its doc comments) |

The apps, at the same addresses either way:

| App | Where |
| --- | --- |
| `dashboard-web` | `http://dashboard.localtest.me:3000`: "Log in" goes through Zitadel (any seeded user, or an account registered on Zitadel's login page) to `/dashboard`, the protected area (a request without a session is sent to the login); the first login creates the user's personal workspace (a "Personal" organization and project with a "Welcome" document), and a login whose provisioning fails is refused rather than left without one; "Log out" ends the session here and at Zitadel. `/dashboard` lists every document the user may view, grouped by organization and project, with "Edit" or "Read-only" decided by SpiceDB; `/documents/<id>/edit` saves through `POST /documents/<id>`, which enforces on the server: with the session cookie and `Origin: http://dashboard.localtest.me:3000`, a `curl` POST of `value1` and `value2` answers `303` for a document the user may edit, `403` for one they may only view, and `404` for one they may not see |
| `tenancy-api` | `http://localhost:4001` under Tilt, `tenancy-api:4001` inside compose (not published): `GET /health` is public; `POST /me/provision`, `GET /me/organizations`, `GET /organizations/:id` need a bearer token of the project, so they are exercised through the apps and the tests rather than a browser |

`localtest.me` and its subdomains resolve to `127.0.0.1` in public DNS, so no hosts-file entry is needed. What each service is for, the ports, profiles, and shared volumes are in [`docker/README.md`](docker/README.md). Each package under `packages/` has a `README.md` on how to use it: [`auth`](packages/auth/README.md), [`authz`](packages/authz/README.md), [`client-scopes`](packages/client-scopes/README.md), [`db-core`](packages/db-core/README.md), [`tenancy`](packages/tenancy/README.md), [`documents`](packages/documents/README.md).
