# Compose stack

What each service in `docker-compose.yml` is for, and the conventions the apps and later tickets follow. The architecture behind it is in [`docs/README.md`](../docs/README.md) §4 (Zitadel), §6 (SpiceDB), and §9 (security posture, including why `.env` is committed).

## Services

| Service | Image | Role | Reached at |
| --- | --- | --- | --- |
| `postgres` | `postgres` | One container, one database per service: `zitadel`, `spicedb`, `tenancy`, `documents` (`comments` in phase 5), created by `postgres/init.sql` on first start, each owned by a same-named role with the role name as password | `postgres:5432` inside compose; `localhost:5432` from the host |
| `zitadel-api` | `ghcr.io/zitadel/zitadel` | The OpenID Provider: identities, credentials, tokens, JWKS, the management and v2 APIs, the console. Configured by environment at first start (`ZITADEL_FIRSTINSTANCE_*`), including the admin user and two machine users whose personal access tokens it writes to the `zitadel-bootstrap` volume | Through `proxy` only |
| `zitadel-login` | `ghcr.io/zitadel/zitadel-login` | Login V2, the login UI of Zitadel v4, served under `/ui/v2/login` on the same origin as the API; authenticates to the API with `login-client.pat` | Through `proxy` only |
| `proxy` | `traefik` | Routes one public origin, `http://auth.localtest.me:8080`, to the API and the login UI, as in Zitadel's reference compose (plain HTTP only) | `http://auth.localtest.me:8080` |
| `spicedb-migrate` | `authzed/spicedb` | One-shot: applies SpiceDB's schema migrations to the `spicedb` database and exits | |
| `spicedb` | `authzed/spicedb` | The authorization service: relationships, checks, lookups, ZedTokens. Clients present the preshared key as a bearer token | `spicedb:50051` inside compose; `localhost:50051` from the host |
| `redis` | `redis` | Application session store (`packages/auth`), append-only so sessions survive a restart | `redis:6379` inside compose; `localhost:6379` from the host |
| `mailpit` | `axllent/mailpit` | SMTP sink for Zitadel's verification and reset emails, with a web UI | SMTP `mailpit:1025` inside compose; UI `http://localhost:8025` |
| `zed` | `authzed/zed` | SpiceDB's CLI, in the `tools` profile so `up` never starts it: `pnpm authz:zed schema read` | |

Every long-running service has a health check, so `docker compose up -d --wait` returns only when the stack is usable. Image tags are pinned in `.env`.

## Hostnames and ports

One hostname per origin, under `localtest.me`, which resolves to `127.0.0.1` in public DNS (`docs/README.md` §4.3, option (a)). Zitadel is `auth.localtest.me:8080` for the browser and for the containers alike: app services get `extra_hosts: ["auth.localtest.me:host-gateway"]` so the same URL works from inside compose, which keeps the OIDC issuer identical on both sides. The apps follow the same scheme because browsers scope cookies by host and ignore the port: `dashboard.localtest.me:3000`, later `tenancy.localtest.me:3001` and `comments.localtest.me:3002`. APIs listen on `4001` (`tenancy-api`), `4002` (`dashboard-api`), `4003` (`comments-api`) and are reached by service name inside compose.

## Zitadel admin

The first-instance admin is `ZITADEL_ADMIN_USERNAME` in `.env`. Zitadel suffixes a username that is not an email with the organization's domain, so the login name is `zitadel-admin@zitadel.auth.localtest.me` (organization `ZITADEL`, the default name). The console is at `http://auth.localtest.me:8080/ui/console`.

## Profiles

- No profile: the infrastructure above. This is what Tilt starts (ticket 5) while the apps run on the host.
- `apps` (from ticket 3): the containerized apps and the bootstrap container, for the reviewer path where everything runs in compose: `docker compose --profile apps up -d --wait`.
- `tools`: one-off CLIs run with `docker compose run --rm`, never started by `up`.

## Shared locations

- Named volume `zitadel-bootstrap`, mounted at `/bootstrap`: `bootstrap.pat` (the bootstrap machine user, which holds `IAM_OWNER`) and `login-client.pat` (used by Login V2). Read-write in `zitadel-api`, read-only in `zitadel-login` and in the bootstrap container (ticket 4); never mounted in an app.
- Bind mount `./.local/config/` (gitignored), mounted at `/config`: the env files the bootstrap container generates for the apps (client IDs, issuer; ticket 4). Read-write in `bootstrap`, read-only in every app; a Tilt-run process on the host reads the same directory.

## Resetting

`docker compose down -v` removes the volumes, so the next `up` reinitializes Postgres (the init script runs again), Zitadel (a new instance, new PATs), SpiceDB, and Redis from scratch.
