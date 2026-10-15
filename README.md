# auth-stack-exercise

A reference IAM stack: OIDC login through a self-hosted Zitadel, fine-grained authorization with SpiceDB, and a small resource dashboard that only lets users edit what they are permitted to edit. TypeScript monorepo (Next.js, Fastify, shared packages); runs with `docker compose up`.

The full architecture, decisions, and phase plan are in [`docs/README.md`](docs/README.md); the work breakdown is in [`docs/TICKETS.md`](docs/TICKETS.md). Run instructions, the seeded users, and the trade-offs list are added to this file in ticket 14.
