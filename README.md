# auth-stack-exercise

A reference IAM stack: OIDC login through a self-hosted Zitadel, fine-grained authorization with SpiceDB, and a small resource dashboard that only lets users edit what they are permitted to edit. TypeScript monorepo (Next.js, Fastify, shared packages); runs with `docker compose up`.

The full architecture, decisions, and phase plan are in [`docs/README.md`](docs/README.md); the work breakdown is in [`docs/TICKETS.md`](docs/TICKETS.md). Run instructions, the seeded users, and the trade-offs list are added to this file in ticket 14.

## Development

Tool versions are pinned in `mise.toml` (Node 22, pnpm 10) and installed with [mise](https://mise.jdx.dev). On a fresh clone:

```sh
mise trust       # once per clone: allow mise to read mise.toml
mise install     # installs the pinned Node and pnpm
pnpm install     # installs the workspace
```

Checks, which are the same ones CI runs:

```sh
pnpm lint          # ESLint plus markdownlint
pnpm format:check  # Prettier (pnpm format rewrites)
pnpm type-check    # tsc --noEmit in every package
pnpm test          # unit tests (Jest); test:integration needs the compose stack, which arrives in ticket 2
```

The infrastructure (Postgres, Zitadel with its login UI behind Traefik, SpiceDB, Redis, Mailpit) runs in Docker Compose with committed development defaults in `.env` (insecure by design, local use only). No setup step and no Node needed:

```sh
docker compose up -d --wait   # 25-80 s from a clean state; returns when every service is healthy
docker compose down -v        # stop and wipe the volumes (fresh Zitadel instance and databases on the next up)
```

| What | Where |
| --- | --- |
| Zitadel login and console | `http://auth.localtest.me:8080` (`/ui/console`); admin `zitadel-admin@zitadel.auth.localtest.me` / `Password1!` |
| Mailpit (every email Zitadel sends) | `http://localhost:8025` |
| Postgres, Redis, SpiceDB from the host | `localhost:5432`, `localhost:6379`, `localhost:50051` (preshared key `dev-preshared-key`) |
| SpiceDB CLI | `pnpm authz:zed schema read` (runs `zed` in a container against the stack; answers "no schema has been defined" until ticket 6 writes one) |

`auth.localtest.me` resolves to `127.0.0.1` in public DNS, so no hosts-file entry is needed. What each service is for, the ports, profiles, and shared volumes are in [`docker/README.md`](docker/README.md). The apps are not here yet; the tickets that add them extend this section.
