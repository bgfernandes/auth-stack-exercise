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

- One feature branch per ticket, named `<ticket>-<slug>` (e.g. `04-bootstrap-container`, `17a-invitations`), branched from `main`. One PR per ticket, merged on GitHub with a **merge commit** (never squash, never rebase-merge): the individual commits are the record of how the work was done and must survive in the clone, and the merge commit marks the ticket boundary, so `git log --first-parent` reads one line per ticket. Because nothing is folded away, every commit must stand on its own: one coherent step with a conventional-commit message, no "wip" or "fix lint" commits (amend or fix up before pushing instead).
- Every PR description opens with `Read first: docs/README.md` and names the ticket.
- Before a ticket is "done": `pnpm lint`, `pnpm type-check`, `pnpm test` pass; the ticket's acceptance criteria are met; the ticket's **Status** line in `docs/TICKETS.md` is updated in the same PR.
- Corrections to the docs are appended as **dated notes** (`> **2026-10-15:** ...`) that win over the surrounding text; never silently rewrite a decision.
- Tickets are listed in implementation order. Phases are ordered so that the earliest end-to-end working slice comes first and the least important work comes last; anything not reached is documented as future work in the root README.

## Stack decisions (settled; see docs/README.md for the why)

- **Monorepo:** pnpm workspaces, no Turborepo. Root-level ESLint flat config, Prettier, Jest (no Vitest), Playwright for the login-and-edit end-to-end flow. Node pinned through mise (`mise.toml`), pnpm pinned through the `packageManager` field.
- **Apps:** `apps/tenancy-api` (Fastify; the higher-order platform API: users, organizations, policy, audit; its own process from phase 1) and `apps/tenancy-web` (Next.js; members and policy management; the second OIDC client, proving single sign-on and single sign-out), `apps/dashboard-web` (Next.js 16, App Router, hybrid SSR, a BFF holding the session; documents domain), `apps/dashboard-api` (Fastify resource server for documents, phase 2), `apps/comments-web` and `apps/comments-api` (second domain, phase 5, only if time allows: cross-domain access), `apps/bootstrap` (idempotent one-shot container that configures Zitadel and seeds data).
- **Packages:** platform packages carry no domain tables: `packages/auth` (framework-agnostic OIDC client, `SessionStore` interface with in-memory and Redis adapters, back-channel logout sink, bearer verification and `ScopeResolver`, authentication-context policy helper; thin `next` and `fastify` subpath adapters), `packages/authz` (SpiceDB client, schema, consistency helpers), `packages/db-core` (connection factory and migration runner only), `packages/config` (shared tsconfig and ESLint presets). Service packages own their database; their root (schema, migrations, services) is imported by exactly one service once the APIs exist, plus bootstrap for migrations and seeds: `packages/tenancy`, `packages/documents`, `packages/comments`. `@auth-stack/tenancy/client` is a subpath with only the HTTP client and types, and is what every other service imports.
- **Infra:** Postgres 17 (separate databases for Zitadel, SpiceDB, tenancy, and each domain), Zitadel v4 with its Login V2 container behind Traefik (taken from Zitadel's reference compose), one Zitadel project holding every application, SpiceDB with the Postgres datastore, Redis for sessions, Mailpit for outbound mail. Compose is the first-class run path; a Tiltfile wraps it for local development. Kubernetes is a late phase.
- **UI:** minimal, server-rendered forms. The UI is not what is being demonstrated.

## Next.js 16 rules

- Request APIs are async only: `await cookies()`, `await headers()`, `await params`, `await searchParams`.
- The request interceptor file is `proxy.ts` (exporting `proxy`), not `middleware.ts`. It runs on the Node runtime.
- No edge runtime anywhere that touches SpiceDB (gRPC) or Postgres. Keep data access in route handlers, server components, and server actions.
- `next lint` no longer exists; ESLint runs from the root config. Turbopack is the default bundler; do not add a `webpack` config.

## Conventions

- Markdown: no hard wrapping. One line per paragraph and per bullet. After editing any `.md` file, run `pnpm lint:md` (markdownlint-cli2, configured in `.markdownlint-cli2.yaml`) and fix what it reports before considering the edit done; `pnpm lint:md:fix` applies the automatic fixes.
- Secrets: development defaults are committed on purpose so the stack starts with zero manual steps; they are labelled as insecure and listed in the trade-offs section of the root README. Never commit a real secret. Gitleaks runs in CI.
- Every enforcement decision is made server-side, on the write path. UI affordances (an Edit button) are hints, never the control.
- Logs and errors never include tokens, session identifiers, or passwords.
