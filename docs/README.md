# Auth Stack Exercise — Architecture & Context

> **📜 Design/decision log.** This folder is the planning artifact for the project. Corrections are appended as dated notes (`> **YYYY-MM-DD:** ...`) that win over the surrounding text; decisions are never silently rewritten. The root `README.md` is the human-readable version of this document for someone running and reviewing the project, and it is kept in sync at the end of every phase.

> **Read this first.** This document is the shared context for every ticket and PR in this repository (`docs/TICKETS.md`). It captures the problem, the architecture, the authorization model, the consistency model, the deployment shape, the security posture, and the phase plan, so any ticket can be picked up without re-deriving context.

## 1. Problem

The system is a web application that authenticates users through a login page and, based on fine-grained permissions, lets them edit values on resources: some resources are editable, some are read-only, and some do not appear at all. Its authentication is secure, its authorization system is scalable, and the whole thing runs from a single `docker compose up`, so anyone can log in as different users and see different dashboards. The design is production-ready and the documentation is honest about it, including a list of trade-offs, shortcuts, and gaps. The design does not limit how the system can be extended, and it answers extension questions of the form "how would you add X" (enterprise SSO, provisioning, machine clients, custom roles, multi-region, swapping a component); §10 collects those answers.

## 2. Approach in one sentence

The system is a small identity platform: a self-hosted OpenID Connect provider (Zitadel) owns identities and sessions, a Zanzibar-style authorization service (SpiceDB) owns relationships and permission checks, and the application layer (a Next.js dashboard acting as a backend-for-frontend, later a Fastify API) is a thin, replaceable client of both, built from shared packages that any future service in the estate would reuse.

### Why not hand-rolled authentication

Two decisions hide in "how do users log in", and they are independent.

The first is **who handles credentials**: password storage, recovery, verification, MFA, lockout, rate limiting, breach response. Framework-provided authentication (Devise, Django's auth, Laravel's) runs fine in production for years, so "never hand-roll" is too strong. What grows with scale is the long tail around the password hash: recovery and verification flows, MFA enrolment and reset, account linking, lockout and credential-stuffing defences, audit. A dedicated identity system, bought or self-hosted, owns that tail; this project delegates it to Zitadel. The depth of the authentication work then shows in the integration surface: the OIDC client and BFF (PKCE, `state`, `nonce`, ID-token validation, cookie attributes, session lifecycle), the resource server's audience checks, just-in-time provisioning, and the threat model in §9.

The second is **how applications talk to that system**, and here OIDC is not the automatic answer. OAuth 2.0 and OIDC are a delegated-authorization framework, not a login protocol: Ory's [Before you use OAuth2](https://www.ory.com/docs/hydra/concepts/before-oauth2) puts the cases where they fit as third-party access to user data, machine-to-machine authorization, heterogeneous device fleets, and an existing investment in an OIDC product, and the cases where you likely do not need them as login, registration, recovery, social sign-in, and a new single-page or mobile app backed by your own API. For a handful of first-party apps on one domain, an identity system plus a session cookie is the simpler production shape, and it is the shape headless systems such as Ory Kratos are built for.

### Why OIDC for first-party applications here

This project still makes its first-party apps OIDC clients, for a reason that comes from experience rather than principle: an identity layer conceived without token audiences, scopes, and client registration is painful to retrofit when the first partner integration, machine client, or public API arrives, because every app's notion of "who is calling" has to change at once. Starting from one provider and OIDC clients makes those concepts exist from day one, at the cost of a redirect-based login and a BFF holding tokens. The non-OIDC alternative is available in the same stack: Zitadel's Session API lets a first-party app drive login directly and share a session cookie, which is what a custom login UI (phase 8) would use. Both shapes are documented so the trade-off is explicit instead of assumed.

## 3. Architecture

```text
                                  ┌──────────────────────────────┐
   Browser ───── login/consent ──►│  Zitadel (IdP, OIDC OP)      │◄─── bootstrap (one-shot)
      │                           │  + Login V2 UI, via Traefik  │
      │  session cookie           └──────────────┬───────────────┘
      ▼                                          │ tokens / JWKS / userinfo
   ┌──────────────────────┐    bearer (phase 2)  ┌▼─────────────────────┐
   │ dashboard-web        │─────────────────────►│ dashboard-api        │
   │ Next.js 16 (BFF)     │                      │ Fastify (resource    │
   │ holds the session,   │   packages/resources │ server)              │
   │ renders pages        │◄── (phase 1 direct) ─┤                      │
   └──────────┬───────────┘                      └──────────┬───────────┘
              │ packages/authz (gRPC)                       │ packages/db (Drizzle)
              ▼                                             ▼
   ┌──────────────────────┐                      ┌──────────────────────┐
   │ SpiceDB              │                      │ Postgres (app DB)    │
   │ relationships, check │                      │ users, orgs,         │
   │ lookup, ZedTokens    │                      │ projects, documents, │
   └──────────────────────┘                      │ sessions, audit      │
                                                 └──────────────────────┘
   Mailpit receives every email Zitadel sends (verification codes, password resets).
```

### 3.1 Components and ownership

| Component | Role | Owns | Source |
| --- | --- | --- | --- |
| Zitadel (`zitadel-api` + `zitadel-login` behind Traefik) | OpenID Provider: registration, login, MFA, password reset, sessions, tokens, JWKS, external IdP brokering | Identities and credentials, in its own Postgres database | Off the shelf, pinned image |
| SpiceDB | Authorization: relationships, `CheckPermission`, `LookupResources`, ZedTokens | Relationship tuples, in its own Postgres database | Off the shelf, pinned image |
| `apps/dashboard-web` | The product: login redirect, session, dashboard, edit form; the BFF that holds tokens server-side | HTTP session cookie, page rendering, enforcement on its own write paths | This repo |
| `apps/dashboard-api` (phase 2) | Resource server behind bearer tokens; the service other apps would call | Resource CRUD, enforcement on every operation | This repo |
| `apps/bootstrap` | One-shot, idempotent container: configures Zitadel (project, OIDC app, seeded users, SMTP), writes the SpiceDB schema, seeds the app database and relationship tuples | Nothing at runtime; it hands configuration to the apps through a shared volume | This repo |
| `packages/auth` | OIDC client for the BFF (discovery, PKCE, `state`, `nonce`, token validation, session store); bearer verification for APIs | The one place OIDC details live | This repo |
| `packages/authz` | SpiceDB client, schema file, typed check/lookup/write helpers, consistency handling | The one place SpiceDB details live | This repo |
| `packages/db` | Drizzle schema and migrations for the resource domain | Tables in §5 | This repo |
| `packages/resources` | Service layer: list, read, update, provision; calls `authz` before every mutation | Business rules | This repo |
| Mailpit | SMTP sink with a web UI at `localhost:8025` | Nothing | Off the shelf |

The IdP and the authorization service are separate processes with separate databases on purpose: they scale, fail, and get upgraded independently, and either can be swapped (Zitadel for Auth0 or Keycloak; SpiceDB for OpenFGA) without touching the other.

### 3.2 Layer model

The design follows a layered identity-platform model so that each concern lives in exactly one place: **L1** the identity provider (Zitadel); **L2** an API gateway enforcing bearer tokens in front of APIs (late phase; until then the Fastify API verifies tokens itself); **L3** a session-status service for logout propagation and revocation queries (late phase); **L5** the in-app OIDC client, reduced to configuration plus session storage (`packages/auth`); **L6** the written contract every client follows (the configuration profile in §9). An edge auth proxy (**L4**) is described but not built.

## 4. Identity: Zitadel

### 4.1 Why Zitadel

- OIDC-native (certified OP), ships a login UI with registration, password reset, MFA, and external-IdP brokering, so the login page required by the problem exists without writing one, and a custom login UI remains possible later through its Session API.
- Organizations, projects, and applications map directly onto a multi-tenant product; identity providers can be registered per organization, which is how enterprise SSO would be added (§10).
- A full management API, so the bootstrap container can configure everything; nothing is clicked in a console.
- Single Go binary plus Postgres; runs comfortably inside the reviewer's compose stack.
- Alternatives considered: Ory Kratos + Hydra (headless, so a login UI must be written, and two services instead of one); Keycloak (capable, heavier Java deployment, larger surface); Auth0 or WorkOS AuthKit (managed, cannot run inside `docker compose up`); hand-rolled (see §2). Zitadel is licensed under the AGPL, which an organization would weigh before adopting; it does not affect this project.

### 4.2 Deployment shape

The compose stack starts from Zitadel's own v4 reference compose: Traefik in front, `ghcr.io/zitadel/zitadel` (API) and `ghcr.io/zitadel/zitadel-login` (Login V2, a Next.js app served under `/ui/v2/login` on the same origin), Postgres behind. Login V2 is required in v4; the API container is configured with `ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true` and the `ZITADEL_OIDC_DEFAULTLOGINURLV2`/`DEFAULTLOGOUTURLV2` URLs, and the login container authenticates to the API with a login-client PAT that the API writes to a shared volume at first start (`ZITADEL_FIRSTINSTANCE_LOGINCLIENTPATPATH`). Pinned version: `v4.19.4` (the current release at the time of writing; Zitadel's own `.env.example` pins `v4.16.0`, and the spike in ticket 3 falls back to that tag if `v4.19.4` misbehaves).

The first instance is created by environment variables (`ZITADEL_FIRSTINSTANCE_*`), including a **machine user with a PAT written to the shared bootstrap volume** (`ZITADEL_FIRSTINSTANCE_PATPATH`, `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME`, `..._ORG_MACHINE_PAT_EXPIRATIONDATE`). The bootstrap container reads that PAT and uses the management API to create the project, the OIDC application, and the seeded users. Zitadel generates the OIDC client ID, so the bootstrap container writes the generated values (client ID, issuer) to the shared volume as an env file that `dashboard-web` sources at start. SMTP points at Mailpit through `ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_HOST=mailpit:1025` (with `..._TLS=false`, `..._FROM`, and `ZITADEL_DEFAULTINSTANCE_DOMAINPOLICY_SMTPSENDERADDRESSMATCHESINSTANCEDOMAIN=false`), so verification and reset emails are visible at `http://localhost:8025`.

### 4.3 The issuer and host problem

Zitadel validates that requests arrive for its configured external domain (`ZITADEL_EXTERNALDOMAIN`, `ZITADEL_EXTERNALPORT`, `ZITADEL_EXTERNALSECURE` must match the public URL, or it answers "Instance not found"), and OIDC requires the issuer string the browser is redirected to and the issuer the server discovers to be identical. In compose the browser reaches Zitadel at `localhost:8080` while the app containers reach it by service name, which breaks both. Two candidate fixes, settled by the spike in ticket 3:

- **(a) One hostname for everyone.** Use a loopback DNS name such as `auth.localtest.me` (resolves to `127.0.0.1` publicly) as `ZITADEL_DOMAIN`, publish Traefik on the host, and give the app containers `extra_hosts: ["auth.localtest.me:host-gateway"]` so the same URL works from inside containers. Simplest; requires public DNS resolution on the machine running the stack (fine for laptops and CI runners).
- **(b) Keep `localhost` and override the host.** App containers call Traefik by service name with a `Host: localhost:8080` header; `openid-client` v6 exposes a custom fetch hook that makes this possible. No DNS dependency, more code in `packages/auth`.

Only the IdP needs the shared hostname; the app's own origin stays `http://localhost:3000`, which is also what is registered as the redirect URI. For local development with Tilt, the apps run on the host (`local_resource`) while only the infrastructure runs in compose, which sidesteps the problem entirely; the reviewer path (everything in compose) is the one that has to be solved.

### 4.4 Login flow (what `packages/auth` implements)

1. `GET /auth/login` builds an authorization request: `response_type=code`, `scope=openid profile email offline_access`, PKCE `S256` (RFC 7636), fresh `state` and `nonce`, stored in a short-lived, signed, `HttpOnly` cookie; redirect to Zitadel's authorization endpoint from discovery.
2. Zitadel's login UI handles registration, password, MFA, and (later) external IdPs; it redirects back to `GET /auth/callback?code&state`.
3. The callback verifies `state`, exchanges the code with `code_verifier`, validates the ID token (`iss`, `aud`, `exp`, `nonce`, signature against JWKS) through `openid-client`, and creates a **server-side session row** (`sessions` table: id, user id, tokens, expiry, `sid` from the ID token). The browser gets only an opaque session ID in a cookie: `HttpOnly`, `Secure` (except on plain-HTTP localhost), `SameSite=Lax`, `Path=/`.
4. Just-in-time provisioning (§6.4) runs on the first login of a `sub`.
5. `GET /auth/logout` deletes the session row and redirects to Zitadel's `end_session_endpoint` with `id_token_hint` and a registered `post_logout_redirect_uri`, so the IdP session ends too.
6. Access tokens never reach the browser. In phase 2 the BFF attaches the session's access token when calling `dashboard-api`, refreshing with the refresh token when expired (rotation and reuse detection are the IdP's job).

Tokens are configured as JWTs in Zitadel (application setting "Auth Token Type: JWT") so `dashboard-api` can verify them against JWKS without a network call per request; introspection (RFC 7662) is the alternative and is noted in §10.

## 5. Resource domain and data model

A deliberately small hierarchy with enough structure for relationship-based access control to earn its place: **organization → project → document**. Projects, not folders: folders imply arbitrary nesting, which needs a recursive schema and buys nothing here.

| Table (`packages/db`) | Columns (abridged) | Notes |
| --- | --- | --- |
| `users` | `id` (Zitadel `sub`, PK), `email`, `display_name`, `created_at` | Mirror created just-in-time at first login; the IdP is the source of truth |
| `organizations` | `id`, `name`, `kind` (`personal` or `shared`), `zedtoken`, `created_at` | `zedtoken` is the consistency anchor (§7) |
| `projects` | `id`, `organization_id`, `name`, `created_at` | |
| `documents` | `id`, `project_id`, `organization_id` (denormalized for filtering), `name`, `value_1`, `value_2`, `updated_at`, `updated_by` | The "values" the problem statement asks to edit |
| `sessions` | `id`, `user_id`, `sid`, `access_token`, `refresh_token`, `id_token`, `expires_at`, `created_at` | Server-side session store (§4.4) |
| `authz_decisions` (phase 3) | `id`, `at`, `subject`, `action`, `resource_type`, `resource_id`, `organization_id`, `allowed`, `consistency`, `request_id`, `latency_ms` | Audit log of decisions (§8) |

Membership and roles are **not** stored in Postgres: they are relationships in SpiceDB. The app database stores content and the consistency token; SpiceDB stores who may do what. Keeping one source of truth per concern avoids the dual-write drift that follows from storing roles in both places.

## 6. Authorization: SpiceDB

### 6.1 Why SpiceDB

- A faithful Zanzibar implementation: relationships, schema with computed permissions, `LookupResources` for "what can this user see", and **ZedTokens** with explicit consistency semantics per request (§7). This is the property the design leans on.
- Postgres datastore, single binary, runs in compose; gRPC API with an official Node client (`@authzed/authzed-node`).
- Caveats give a path to attribute-based rules without leaving the relationship model.
- Alternatives: **OpenFGA** (the same model with an HTTP API and a DSL; wider adoption; its consistency control is a per-request `HIGHER_CONSISTENCY` flag rather than a snapshot token, which is the discriminating difference for this design); **Ory Keto** (the Zanzibar model, but the project has moved slowly, and a production deployment I have seen stayed pinned to an alpha release for years because upgrading an authorization store that every product path depends on is hard: the cost of choosing the wrong engine); application-side RBAC tables (simple, but every new resource type or sharing rule becomes a schema migration and a code path, and nothing answers "list everything I can see" efficiently).

### 6.2 Schema

```zed
definition user {}

definition organization {
    relation admin: user
    relation member: user

    permission administer = admin
    permission view = admin + member
    permission create_project = admin + member
}

definition project {
    relation organization: organization
    relation owner: user
    relation editor: user
    relation viewer: user

    permission administer = owner + organization->administer
    permission edit = owner + editor + organization->administer
    permission view = owner + editor + viewer + organization->administer
    permission share = administer
}

definition document {
    relation project: project
    relation editor: user
    relation viewer: user

    permission edit = editor + project->edit
    permission view = viewer + editor + project->view
}
```

Design points. Organization **members** do not see projects by inheritance; only organization **admins** do. That is what makes a project "unavailable" to a member who was not added to it, which the problem statement requires. Project roles flow down to documents; direct document shares (`document#editor`, `document#viewer`) allow the read-only and editable states to differ inside one project. Roles are named bundles of relations rather than a `role` relation with string values, so a new role is a schema change reviewed like code, and permissions stay computable by `LookupResources`.

### 6.3 Seeded scenario

| User | Password (dev only) | Relationships | Dashboard |
| --- | --- | --- | --- |
| `alice@example.com` | `Password1!` | `organization:acme#admin` | Every document in Acme, all editable |
| `bob@example.com` | `Password1!` | `organization:acme#member`, `project:marketing#editor` | Marketing documents editable; Finance project absent |
| `carol@example.com` | `Password1!` | `organization:acme#member`, `project:marketing#viewer`, `document:launch-plan#editor` | "Launch plan" editable (direct share), "Budget" read-only, Finance absent |

Acme has two projects, Marketing ("Launch plan", "Budget") and Finance ("Payroll"). The structural relationships that make the arrows in §6.2 fire are seeded with them: `project:marketing#organization@organization:acme`, `project:finance#organization@organization:acme`, and `document:<id>#project@project:<id>` for each of the three documents. Carol is the reviewer's user: her dashboard shows all three states at once. Each seeded user also gets a personal workspace on first login (§6.4). The password policy is Zitadel's default (8+ characters with upper, lower, digit, symbol); seeded users are created with verified emails so no Mailpit step is needed to log in.

### 6.4 Just-in-time provisioning and the sign-up story

A user who registers through Zitadel's login UI arrives at the callback with a `sub` the app has never seen. In one transaction the app inserts the `users` row, creates a personal organization and a "Personal" project, inserts one example document, and writes the relationships `organization:<id>#admin@user:<sub>` and `project:<id>#organization@organization:<id>`, `document:<id>#project@project:<id>`. The returned ZedToken is stored on the organization. JIT beats IdP webhooks or actions for this: it cannot be missed, needs no inbound connectivity to the app, and makes the first dashboard non-empty.

### 6.5 Enforcement points

- **Dashboard:** one `LookupResources(document, view, user:<sub>)` call (it is not scoped by organization and may run at `minimize_latency`, because the next step re-verifies), join the returned IDs to `documents` rows and **group them by `organization_id`**, then one `CheckBulkPermissions` request per organization carrying that organization's `at_least_as_fresh` ZedToken and checking both `view` and `edit` for every document in the group. `view` decides whether the row is shown at all; `edit` decides between "Edit" and "Read-only". The button is a hint.
- **Edit form (GET) and save (POST):** `CheckPermission(document:<id>, edit, user:<sub>)` on the server before reading or writing. A user who posts a crafted request for a document they can only view gets `403`; one who posts for a document they cannot see gets `404` (no existence leak).
- **Phase 2:** the same checks move into `dashboard-api`; `dashboard-web` stops calling `packages/authz` directly and the API becomes the only enforcement point for resources.

## 7. Consistency: ZedTokens and the New Enemy problem

Authorization data is replicated and cached, so a check may run against a snapshot older than the latest write. The Zanzibar paper names two failures that follow: (1) **neglecting update order** — Alice removes Bob from a project and then adds a document; a check served from a snapshot between the two still lets Bob see the new document; (2) **applying an old ACL to new content** — Bob is removed, content is added, and Bob's check against the older snapshot passes. SpiceDB's default consistency, `minimize_latency`, permits both windows.

The remedy is the snapshot token: every `WriteRelationships` returns a **ZedToken** marking the datastore revision after the write. The application stores it next to the protected data and passes it back as `at_least_as_fresh` on `CheckPermission`, `CheckBulkPermissions`, and `LookupResources`. The check then sees at least the revision in which that data's permissions were last written, without forcing `fully_consistent` on every call.

**Granularity decision.** ZedTokens are opaque to clients, so two tokens cannot be compared or merged; a check can carry only one. The token therefore lives at the **organization**, the tenancy boundary: every relationship write under an organization (membership, project roles, document shares, new documents) updates `organizations.zedtoken`, and every check or lookup for a resource in that organization uses it. The cost is one extra read of the organization row per request, which the request already loads for scoping. It also dictates the dashboard's shape: `CheckBulkPermissions` carries a single `consistency` field for the whole request, so documents are grouped by organization and checked one organization at a time, each group with its own token (§6.5). Alternatives rejected: a per-document token (finer, but membership changes on the project would have to fan out to every document's token to close case 2), and `fully_consistent` on every check (correct and simplest, but it bypasses the cache on the hot path and on some datastores still does not guarantee read-after-write). `at_exact_snapshot` is used nowhere; it exists for paginating a stable view.

## 8. Audit and observability

Every enforcement point records a **decision** (phase 3): who, what action, which resource, in which organization, the outcome, the consistency mode used, the request ID, and latency. A decision is the application's conclusion; a **check** is a SpiceDB call. They differ in count (one dashboard decision is backed by one lookup and one bulk check) and some decisions never reach SpiceDB (no session: deny). Decisions go to the `authz_decisions` table and are queryable per organization, which is the shape a customer-facing "who could do what" view needs. Checks are recorded as OpenTelemetry spans with the consistency mode as an attribute (phase 5), alongside HTTP and database spans, exported over OTLP to a collector in a compose profile.

## 9. Security posture (the configuration profile)

| Concern | Decision |
| --- | --- |
| Credentials | Never handled by the app. Zitadel stores password hashes (its default policy; bcrypt-family, configurable), rate-limits login attempts, and runs lockout and password-reset flows. The app never sees a password. |
| Session cookie | Opaque ID to a server-side row; `HttpOnly`, `SameSite=Lax`, `Secure` outside localhost, no `Domain` attribute. Idle timeout and absolute lifetime enforced on the row. Logout deletes the row and ends the IdP session. |
| OIDC client | Authorization code + PKCE `S256`; `state` and `nonce` single-use and bound to the login attempt; exact-match redirect URIs registered in Zitadel; ID token validated by `openid-client` (`iss`, `aud`, `exp`, `nonce`, signature). Tokens never leave the server. |
| CSRF | State-changing routes accept `POST` only, check `Origin`/`Sec-Fetch-Site` against the app origin, and (phase 4) carry a per-session CSRF token in forms. `SameSite=Lax` is the first line, not the only one. |
| Authorization | Server-side on every read and write path (§6.5); deny by default; `404` for unseen resources, `403` for seen-but-forbidden. |
| Input | Validated with a schema (zod) at the route boundary; document values are bounded strings; IDs are opaque. |
| Headers | `Content-Security-Policy` (no inline scripts), `X-Content-Type-Options`, `Referrer-Policy`, `Frame-Options`/`frame-ancestors`, HSTS behind TLS (phase 4). |
| Rate limiting | Zitadel on authentication; app-level limits on the callback and on mutations (phase 4). |
| Secrets | Development defaults committed on purpose (zero-step start); labelled insecure; `.env.example` documents each; Gitleaks in CI; production would inject from a secret store. |
| Logging | Request IDs everywhere; no tokens, session IDs, or passwords in logs. |
| Dependencies | Lockfile committed; `pnpm audit` in CI (non-blocking at first). |
| Transport | Plain HTTP on localhost by design; TLS terminates at Traefik in any real deployment (Zitadel's compose overlays show the modes). |

## 10. Extension paths (the questions this design is built to answer)

- **Enterprise SSO (SAML, OIDC federation):** register the customer's IdP as an external identity provider on their Zitadel organization (Zitadel acts as the SAML service provider or OIDC relying party) and set the organization's login policy to require it; no app code changes. A multi-tenant SSO broker (WorkOS, Ory Polis) can sit upstream the same way, with the organization selected before redirect, which is why the IdP registry is per organization.
- **SCIM provisioning:** a small worker consuming directory webhooks (or Zitadel's SCIM endpoint, currently a preview feature) that creates users through the management API and maps directory groups to `organization#member` and `project#<role>` relationships. This worker is the first "auth service" app the monorepo would gain.
- **Machine-to-machine access and API keys:** client credentials (RFC 6749 §4.4) on Zitadel for services, JWT profile for private-key clients, and API keys stored by the app that exchange into short-lived tokens; all end up as `user:<id>` or `service:<id>` subjects in SpiceDB.
- **Custom roles, hierarchies, ABAC:** new relations and permissions in the schema (reviewed like code); nested organizations through `organization#parent` with `parent->administer` arrows; attribute rules through SpiceDB caveats (time windows, IP ranges, plan tiers).
- **An API gateway (L2):** Traefik ForwardAuth or Envoy `ext_authz` in front of `dashboard-api`, verifying bearer tokens and injecting the subject, so individual services stop validating tokens; configuration, not code.
- **Logout propagation (L3):** Zitadel back-channel logout to a sink that marks sessions by `sid`; the BFF checks the mark on each request and re-validates silently on an interval.
- **Multi-region:** SpiceDB on CockroachDB or Spanner for a global relationship store with the same ZedToken semantics; the app database partitioned by organization; the IdP replicated with Zitadel's multi-region guidance. Permission checks stay local to the region that holds the relationships, with `at_least_as_fresh` preventing cross-region staleness from becoming a New Enemy.
- **Swapping the IdP:** everything the apps know about Zitadel is the issuer URL and a client registration; `packages/auth` works from discovery. Swapping to Auth0 or Keycloak is bootstrap work, not app work.
- **Swapping the authorization engine:** `packages/authz` is the only SpiceDB-aware code; OpenFGA has the same model minus snapshot tokens, so §7 would be rewritten around its consistency flag.

## 11. Phase plan

The order follows one principle: the earliest end-to-end working slice first, then widen, with the least important work last. Anything not reached is documented as future work in the root README, which the problem statement explicitly asks for.

| Phase | Delivers | Why in this position |
| --- | --- | --- |
| 0 — Foundation | Monorepo scaffold, compose stack (Postgres, Zitadel + login, Traefik, SpiceDB, Mailpit), the Zitadel spike (host mapping, one real login), bootstrap container, Tiltfile, CI skeleton | Everything else depends on a login that works from inside compose |
| 1 — Vertical slice | SpiceDB schema and `packages/authz`, `packages/db`, `packages/auth` BFF, JIT provisioning, dashboard with the three states, edit flow with server-side enforcement, seeded users, Playwright login-and-edit test, root README v1 | **Minimum viable submission:** phase 1 plus the README satisfies every hard requirement |
| 2 — Resource server | `dashboard-api` on Fastify verifying bearer tokens (JWKS, `iss`, `aud`); `dashboard-web` calls it with the session's access token; `packages/resources` moves behind the API | Same service code, new host: low cost, and it is the "how would you add a second app" answer |
| 3 — Consistency and audit | ZedToken on organizations with `at_least_as_fresh` everywhere; `authz_decisions` table and a per-organization audit page | The design's strongest talking point, made real |
| 4 — Hardening | CSRF tokens, security headers and CSP, rate limits, input validation audit, Gitleaks and `pnpm audit` in CI, unit and integration tests filled out, README trade-offs section | Security reviewers read this phase |
| 5 — Observability | OpenTelemetry tracing across web, API, SpiceDB and Postgres calls; collector and Jaeger in a compose profile | Cheap once the structure exists |
| 6 — Kubernetes | Kustomize or Helm manifests, a `kind` cluster, a second Tiltfile for Kubernetes | Production-like deployment; optional, documented if unreached |
| 7 — Gateway | Traefik ForwardAuth or Envoy `ext_authz` in front of `dashboard-api` | Configuration-only demonstration of L2 |
| 8 — Identity extensions | A second OIDC provider brokered through Zitadel (SSO demo); optionally a custom login UI on the Session API, or an IdP abstraction layer | Shows the extension paths in §10 running |

## 12. Decision log

> **2026-10-13:** Initial decisions recorded in this document: Zitadel over Kratos + Hydra; SpiceDB over OpenFGA and Keto; organization → project → document (projects, not folders); server-side sessions in Postgres with an opaque cookie; ZedToken stored per organization; compose first, Tilt wraps compose, Kubernetes last; TypeScript monorepo with pnpm workspaces, Jest, Playwright; minimal UI; Mailpit in compose; three seeded users plus JIT personal workspaces; development secrets committed and labelled.
