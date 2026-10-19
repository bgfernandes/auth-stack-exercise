# CLAUDE.md

Working agreement and context for this repository. Read this first, then `docs/README.md` (architecture and decisions) and `docs/TICKETS.md` (the work, in order).

## What this repo is

A reference IAM stack: OIDC login through a self-hosted Zitadel, fine-grained authorization with SpiceDB, and a small resource dashboard that only lets users edit what they are permitted to edit. It is a TypeScript monorepo (Next.js apps, Fastify API, shared packages) that runs with `docker compose up`. `docs/README.md` is the single source of context; the root `README.md` is the human-readable version for someone running and reviewing the project.

## Working agreement

How this project was and is built, so an agent opening this repository works the same way.

- **The maintainer sets the direction and makes every design decision; coding agents (Claude Code) write the code and draft the documents from `docs/README.md`.** Work in small logical steps: one ticket at a time, and inside a ticket, one coherent change at a time, explained before it is written. Never batch several tickets into one change.
- **Every open design question goes to the maintainer before implementation**, with the options and a recommendation; the choice is recorded in `docs/README.md`, in the section it affects and in the decision log, and in the ticket's dated notes. Deviations from a ticket's text during implementation are recorded the same way.
- **Review is by documentation and by tests, not by reading every line.** The maintainer reviews the design documents, the decisions, and the ticket notes closely; the code is reviewed by the test suites, CI, and independent review agents working from the documentation (cold reads of the design, reviews against the problem statement, against the SpiceDB documentation, and against [an OIDC/SSO checklist](docs/oidc-sso-checklist.md)), whose findings are recorded in the decision log and acted on in tickets.
- **Commits:** the maintainer commits and merges by default; an agent commits only when the maintainer asks for it for a named task, one commit per change, and never pushes or opens pull requests. Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`); no `Co-Authored-By` trailer, since the root README states how the project is built and the trailer would only add noise to the history.
- Be direct about errors, the maintainer's and the agents'. Cite RFCs and specs by name when reasoning about protocols.

## Ticket workflow

- One feature branch per ticket, named `<ticket>-<slug>` (e.g. `04-bootstrap-container`, `17a-invitations`), branched from `main`. One PR per ticket, merged on GitHub with a **merge commit** (never squash, never rebase-merge): the individual commits are the record of how the work was done and must survive in the clone, and the merge commit marks the ticket boundary, so `git log --first-parent` reads one line per ticket. Because nothing is folded away, every commit must stand on its own: one coherent step with a conventional-commit message, no "wip" or "fix lint" commits (amend or fix up before pushing instead).
- Every PR description opens with `Read first: docs/README.md` and names the ticket.
- Before a ticket is "done": `pnpm lint`, `pnpm type-check`, `pnpm test` pass; the ticket's acceptance criteria are met; the ticket's **Status** line in `docs/TICKETS.md` is updated in the same PR.
- Every package under `packages/` has a `README.md` that says how to use it: its env contract, its entry points and subpaths, a usage example, and how to run its checks. Any ticket that implements or changes a package updates that README in the same PR.
- The root `README.md` has a **Development** section that is always current: any ticket that changes how the project is set up or run locally (tool pins, install steps, compose profiles, Tilt, scripts, seeded users) updates that section in the same PR. It is written incrementally, not deferred to a docs ticket.
- `docs/README.md` is kept **accurate on its own**: a correction or an as-built refinement rewrites the paragraph or table it affects, never a note appended under it, and the decision log (`docs/README.md` §12) records what changed and, when it matters, what the text said before. Entries in the decision log are always appended at the end of the file, in chronological order, never inserted between earlier entries. `docs/TICKETS.md` keeps **dated notes** per ticket (`> **2026-10-15:** ...`) that win over the ticket's text: a ticket's record is chronological.
- Tickets are listed in implementation order. Phases are ordered so that the earliest end-to-end working slice comes first and the least important work comes last; anything not reached is documented as future work in the root README.

## Stack decisions (settled; see docs/README.md for the why)

- **Monorepo:** pnpm workspaces, no Turborepo. Root-level ESLint flat config, Prettier, Jest (no Vitest), Playwright for the login-and-edit end-to-end flow. Node pinned through mise (`mise.toml`), pnpm pinned through the `packageManager` field.
- **Apps:** `apps/tenancy-api` (Fastify; the higher-order platform API: users, organizations, policy, audit; its own process from phase 1) and `apps/tenancy-web` (Next.js; members and policy management; the second OIDC client, proving single sign-on and single sign-out), `apps/dashboard-web` (Next.js 16, App Router, hybrid SSR, a BFF holding the session; documents domain), `apps/dashboard-api` (Fastify resource server for documents, phase 2), `apps/comments-web` and `apps/comments-api` (second domain, phase 5, only if time allows: cross-domain access), `apps/bootstrap` (idempotent one-shot container that configures Zitadel and seeds data).
- **Packages:** platform packages carry no domain tables: `packages/auth` (framework-agnostic OIDC client, `SessionStore` interface with in-memory and Redis adapters, back-channel logout sink, bearer verification and `ScopeResolver`, authentication-context policy helper; thin `next` and `fastify` subpath adapters), `packages/authz` (SpiceDB client, schema, consistency helpers), `packages/client-scopes` (the client-authority workaround of §6.7: scope grants in SpiceDB and their resolver; deletable as a unit), `packages/db-core` (connection factory and migration runner only), `packages/config` (shared tsconfig and ESLint presets). Service packages own their database; their root (schema, migrations, services) is imported by exactly one service once the APIs exist, plus bootstrap for migrations and seeds: `packages/tenancy`, `packages/documents`, `packages/comments`. `@auth-stack/tenancy/client` is a subpath with only the HTTP client and types, and is what every other service imports.
- **Infra:** Postgres 17 (separate databases for Zitadel, SpiceDB, tenancy, and each domain), Zitadel v4 with its Login V2 container behind Traefik (taken from Zitadel's reference compose), one Zitadel project holding every application, SpiceDB with the Postgres datastore, Redis for sessions, Mailpit for outbound mail. Compose is the first-class run path; a Tiltfile wraps it for local development. Kubernetes is a late phase.
- **UI:** minimal, server-rendered forms. The UI is not what is being demonstrated.

## Next.js 16 rules

- Request APIs are async only: `await cookies()`, `await headers()`, `await params`, `await searchParams`.
- The request interceptor file is `proxy.ts` (exporting `proxy`), not `middleware.ts`. It runs on the Node runtime.
- No edge runtime anywhere that touches SpiceDB (gRPC) or Postgres. Keep data access in route handlers, server components, and server actions.
- `next lint` no longer exists; ESLint runs from the root config. Turbopack is the default bundler; do not add a `webpack` config.
- Relative imports carry no file extension anywhere in the workspace (`moduleResolution: bundler` in every tsconfig). Turbopack does not remap `.js` to `.ts`, so a package written the NodeNext way cannot be imported by a web app from source, and nothing runs the TypeScript sources natively (esbuild bundles bootstrap, Jest and Next resolve `.ts`).

## Conventions

- Markdown: no hard wrapping. One line per paragraph and per bullet. After editing any `.md` file, run `pnpm lint:md` (markdownlint-cli2, configured in `.markdownlint-cli2.yaml`) and fix what it reports before considering the edit done; `pnpm lint:md:fix` applies the automatic fixes.
- Secrets: development defaults are committed on purpose so the stack starts with zero manual steps; they are labelled as insecure and listed in the trade-offs section of the root README. Never commit a real secret. Gitleaks runs in CI.
- Every enforcement decision is made server-side, on the write path. UI affordances (an Edit button) are hints, never the control.
- Logs and errors never include tokens, session identifiers, or passwords.
