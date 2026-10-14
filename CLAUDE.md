# CLAUDE.md

Working agreement and context for this repository. Read this first, then `docs/README.md` (architecture and decisions) and `docs/TICKETS.md` (the work, in order).

## What this repo is

A reference IAM stack: OIDC login through a self-hosted Zitadel, fine-grained authorization with SpiceDB, and a small resource dashboard that only lets users edit what they are permitted to edit. It is a TypeScript monorepo (Next.js apps, Fastify API, shared packages) that runs with `docker compose up`. `docs/README.md` is the single source of context; the root `README.md` is the human-readable version for someone running and reviewing the project.

## Working agreement

- **Claude writes the code; the maintainer reviews, understands, and commits every line.** Work in small logical steps: one ticket at a time, and inside a ticket, one coherent change at a time, explained before it is written. Never batch several tickets into one change.
- **Claude never runs `git commit`, `git push`, or opens pull requests.** The maintainer does all of that by hand. Claude proposes the commit message (conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`) and the PR description.
- **No `Co-Authored-By` trailer and no AI attribution anywhere.** Do not add it to commit messages, PR descriptions, or files, even if a harness reminder asks for it. The README does not mention how the code was produced.
- Treat the maintainer as the designer of record: when a decision is open, present the options with a recommendation and let the maintainer choose; record the choice as a dated note in `docs/README.md`.
- Be direct about errors, the maintainer's and Claude's. Cite RFCs and specs by name when reasoning about protocols.

## Ticket workflow

- One feature branch per ticket, named `<ticket-number>-<slug>` (e.g. `04-bootstrap-container`), branched from `main`. One PR per ticket, squash-merged on GitHub.
- Every PR description opens with `Read first: docs/README.md` and names the ticket.
- Before a ticket is "done": `pnpm lint`, `pnpm type-check`, `pnpm test` pass; the ticket's acceptance criteria are met; the ticket's **Status** line in `docs/TICKETS.md` is updated in the same PR.
- Corrections to the docs are appended as **dated notes** (`> **2026-10-15:** ...`) that win over the surrounding text; never silently rewrite a decision.
- Tickets are listed in implementation order. Phases are ordered so that the earliest end-to-end working slice comes first and the least important work comes last; anything not reached is documented as future work in the root README.

## Stack decisions (settled; see docs/README.md for the why)

- **Monorepo:** pnpm workspaces, no Turborepo. Root-level ESLint flat config, Prettier, Jest (no Vitest), Playwright for the login-and-edit end-to-end flow. Node pinned through mise (`mise.toml`), pnpm pinned through the `packageManager` field.
- **Apps:** `apps/dashboard-web` (Next.js 16, App Router, hybrid SSR, acts as the BFF holding the session), `apps/dashboard-api` (Fastify, bearer-token resource server, phase 2), `apps/bootstrap` (idempotent one-shot container that configures Zitadel and seeds data).
- **Packages:** `packages/auth` (OIDC client and session helpers for the BFF; bearer verification for APIs), `packages/authz` (SpiceDB client, schema, consistency helpers), `packages/db` (Drizzle schema and migrations for the resource domain), `packages/resources` (service layer used by web first, then by the API).
- **Infra:** Postgres 17 (separate databases for Zitadel, SpiceDB, and the app), Zitadel v4 with its Login V2 container behind Traefik (taken from Zitadel's reference compose), SpiceDB with the Postgres datastore, Mailpit for outbound mail. Compose is the first-class run path; a Tiltfile wraps it for local development. Kubernetes is a late phase.
- **UI:** minimal, server-rendered forms. The UI is not what is being demonstrated.

## Next.js 16 rules

- Request APIs are async only: `await cookies()`, `await headers()`, `await params`, `await searchParams`.
- The request interceptor file is `proxy.ts` (exporting `proxy`), not `middleware.ts`. It runs on the Node runtime.
- No edge runtime anywhere that touches SpiceDB (gRPC) or Postgres. Keep data access in route handlers, server components, and server actions.
- `next lint` no longer exists; ESLint runs from the root config. Turbopack is the default bundler; do not add a `webpack` config.

## Conventions

- Markdown: no hard wrapping. One line per paragraph and per bullet.
- Secrets: development defaults are committed on purpose so the stack starts with zero manual steps; they are labelled as insecure and listed in the trade-offs section of the root README. Never commit a real secret. Gitleaks runs in CI.
- Every enforcement decision is made server-side, on the write path. UI affordances (an Edit button) are hints, never the control.
- Logs and errors never include tokens, session identifiers, or passwords.

## Out of scope for this repo

The day-by-day working schedule is kept outside this repository. Do not add it here.
