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

The runtime stack (Postgres, Zitadel, SpiceDB, Redis, Mailpit) and the apps are not here yet; the commands to run them are added to this section by the tickets that introduce them.
