# System Overview

High-level view of how Threa's services are composed, how they communicate, and what infrastructure each depends on.

## Service Map

```
                           app.threa.io                          admin.threa.io
                                |                                      |
                     +----------+----------+               +-----------+-----------+
                     |                     |               |                       |
                 /api/*              everything else    /api/*                everything else
                     |                     |               |                       |
           +---------v----------+   +------v-------+ +-----v------------+   +------v---------+
           | Workspace Router   |   |   Frontend   | | Backoffice Router|   |   Backoffice   |
           | (Cloudflare Worker)|   | (CF Pages)   | | (Cloudflare Wkr) |   | (CF Pages)     |
           +---------+----------+   +--------------+ +-----+------------+   +----------------+
                     |                                     |
          +----------+----------+                          |
          |                     |                          |
    /api/auth/*           /api/workspaces/:id/*            |
    /api/workspaces       (region-scoped)                  |
    /api/regions               |                           |
          |              region lookup            /api/backoffice/*
          |              (CF KV cache)                     |
          |                    |                           |
   +------v-------+    +------v-------+                    |
   | Control Plane |<--+--------------|--------------------+
   | (Railway)     |    |   Backend    |
   +------+--------+    | (Railway)    |
          |             +------+-------+
          |                    |
          |  +--------+       |
          +->| Pg (CP)|       +----> PostgreSQL (regional)
          |  +--------+       +----> AWS S3 (regional)
          |                   +----> OpenRouter (AI)
          +----> Cloudflare KV
          +----> WorkOS (auth)

    wss://ws-eu.threa.io --------> Backend (direct WebSocket)
```

### Request Routing

All browser traffic hits `app.threa.io`. Cloudflare Workers Routes claim `/api/*` and forward to the workspace router; everything else falls through to Cloudflare Pages (the frontend SPA).

The workspace router inspects the path to decide the destination:

| Pattern                      | Destination                                |
| ---------------------------- | ------------------------------------------ |
| `/api/auth/*`                | Control plane                              |
| `GET/POST /api/workspaces`   | Control plane                              |
| `/api/regions`               | Control plane                              |
| `/api/workspaces/:id/config` | Responds directly with `{ region, wsUrl }` |
| `/api/workspaces/:id/*`      | Regional backend (region resolved via KV)  |

WebSocket connections bypass the router entirely. The frontend fetches `/api/workspaces/:id/config` to get the regional WebSocket URL (e.g. `wss://ws-eu.threa.io`), then connects directly.

---

## Frontend

**What:** React 19 SPA — the user interface for the main application.

**Deployed on:** Cloudflare Pages (`threa-frontend` project) at `app.threa.io`.

**Deploy trigger:** Automatic on push to `main` via `.github/workflows/deploy-cloudflare.yml` (job: `deploy-frontend`).

**Key infrastructure dependencies:**

- Cloudflare Pages (static hosting + SPA routing via `_redirects`)

**Talks to:**

- Workspace router via relative fetch (`/api/...`, cookie auth)
- Regional backend directly via WebSocket (`wss://ws-eu.threa.io`, cookie auth)

**Stack:** React 19, Vite 6, TailwindCSS, Shadcn UI (Radix), TanStack Query v5, TipTap v3 (editor), socket.io-client, Dexie (IndexedDB for offline drafts).

**Key patterns:**

- Cache-only observer pattern for TanStack Query (see `CLAUDE.md` Frontend Patterns)
- Subscribe-then-bootstrap for real-time data; re-bootstraps on socket reconnect (INV-53)
- No configurable API base URL — relies on the workspace router handling `/api/*` in production, Vite proxy in dev

---

## Backoffice

**What:** Internal platform-admin SPA — workspace registry browser, workspace owner invitation manager, and the eventual home of any future operator-only tooling (billing, audits, support). Gated to platform admins only.

**Deployed on:** Cloudflare Pages (`threa-backoffice` and `threa-backoffice-staging` projects) at `admin.threa.io` and `admin-staging.threa.io`.

**Deploy trigger:** Automatic on push to `main` via `.github/workflows/deploy-cloudflare.yml` (jobs: `deploy-backoffice`, `deploy-backoffice-staging`).

**Key infrastructure dependencies:**

- Cloudflare Pages (static hosting)

**Talks to:**

- Backoffice router via relative fetch (`/api/...`, cookie auth) — backoffice has no regional backend, no workspace-router hop, only the control-plane

**Stack:** React 19, Vite 6, TailwindCSS, Shadcn UI primitives (button/card/input/label/badge/alert-dialog/drawer/dropdown-menu), TanStack Query v5, react-router-dom 7, vaul (mobile drawers).

**Key patterns:**

- TanStack Query is the single source of truth for server state — no IndexedDB, no offline story, no socket subscriptions
- Editorial design vocabulary mirroring the main app: uppercase eyebrow labels per section, `divide-y border-y` row containers with left-border hover accents, single `max-w-5xl` content width
- Responsive dialogs (`<ResponsiveAlertDialog>`) switch between Radix `AlertDialog` on desktop and vaul `Drawer` on mobile via a single context-driven mode read
- Two-step destructive interactions: account menu opens before sign-out, confirm dialog opens before invitation revoke

---

## Workspace Router

**What:** Thin edge routing layer that delegates API requests to the correct regional backend or the control plane.

**Deployed on:** Cloudflare Workers at `app.threa.io/api/*`.

**Deploy trigger:** Automatic on push to `main` via `.github/workflows/deploy-cloudflare.yml` (job: `deploy-workspace-router`).

**Key infrastructure dependencies:**

- Cloudflare KV (`WORKSPACE_REGIONS` namespace) — caches workspace-to-region mappings

**Talks to:**

- Control plane (auth routes, workspace list/create, region resolution on KV cache miss)
- Regional backend (workspace-scoped API requests)

**How region resolution works:**

1. Extract `workspaceId` from URL path
2. Check Cloudflare KV for cached `workspaceId -> region` mapping
3. On cache miss: call control plane at `GET /internal/workspaces/:id/region`, cache result in KV
4. Proxy the request to the resolved region's backend URL

**Auth forwarding:** Passes through the browser's `Cookie` header (WorkOS session cookie, name per env: `wos_session` in prod, `wos_session_staging` in staging) and all standard headers. The downstream service validates the session.

**Inter-service auth:** Uses `INTERNAL_API_KEY` in a custom header (`X-Internal-API-Key`) when calling the control plane's internal endpoints.

---

## Backoffice Router

**What:** Tiny edge routing layer that fronts the backoffice. Independent of the workspace router so the backoffice doesn't inherit any workspace-routing concerns.

**Deployed on:** Cloudflare Workers at `admin.threa.io/*` (prod: `backoffice-router`) and `admin-staging.threa.io/*` (staging: `backoffice-router-staging`). Route bindings are declarative in `apps/backoffice-router/wrangler.production.toml` and `wrangler.staging.toml` respectively.

**Deploy trigger:** Automatic on push to `main` via `.github/workflows/deploy-cloudflare.yml` (jobs: `deploy-backoffice-router`, `deploy-backoffice-router-staging`).

**Talks to:**

- Control plane (every `/api/*` request, plus `/test-auth-login*` in stub-auth dev)
- The backoffice CF Pages deployment (every other path, via the `PAGES_PROJECT` env var)

**What it routes:**

| Pattern             | Destination                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `/readyz`           | Returns 200 directly (router health)                                   |
| `/api/*`            | Control plane                                                          |
| `/test-auth-login*` | Control plane (stub-auth dev only)                                     |
| Everything else     | `threa-backoffice.pages.dev` (or `threa-backoffice-staging.pages.dev`) |

**Security posture:** Mirrors the workspace router — trust only `CF-Connecting-IP`, strip client-supplied `X-Forwarded-For` to prevent rate-limit bypass on the control plane, set `X-Forwarded-Host`/`-Proto` plus the custom `X-Threa-Host` header so the control plane can build per-host redirect URIs. The control plane reads `X-Threa-Host` (not `X-Forwarded-Host`, which Railway's edge overwrites) — see `WORKOS_DEDICATED_REDIRECT_HOSTS` in `docs/deployment.md`.

**Why a router instead of binding the Pages project to `admin.threa.io` directly:** Same-origin proxying through the worker means the WorkOS session cookie lands on `admin.threa.io` directly with no `SameSite` cross-origin pain, and the control plane can use a per-host WorkOS redirect URI override based on the forwarded host header.

---

## Control Plane

**What:** Small, centralised server handling concerns that must be global: authentication, workspace creation, region assignment, invitation shadows, and workspace-to-region KV sync.

**Deployed on:** Railway (auto-deploy on push to `main`). Docker image from `Dockerfile.control-plane`.

**Deploy trigger:** Automatic on merge to `main`.

**Key infrastructure dependencies:**

- PostgreSQL (own `control_plane` database on the shared Railway Postgres instance) — stores workspace records and outbox
- WorkOS — OAuth/SSO authentication provider
- Cloudflare KV — writes workspace-to-region mappings so the router can resolve them at the edge

**Public endpoints (proxied through workspace router):**

- `GET /api/auth/login` — initiate WorkOS OAuth flow
- `ALL /api/auth/callback` — OAuth callback
- `GET /api/auth/logout` — clear session
- `GET /api/auth/me` — current user
- `GET /api/workspaces` — list user's workspaces
- `POST /api/workspaces` — create workspace (assigns region, triggers provisioning)
- `GET /api/regions` — available regions

**Public endpoints (proxied through backoffice router, gated by `requirePlatformAdmin`):**

- `GET /api/backoffice/me` — identity + `isPlatformAdmin` (auth only, lets the UI render a friendly 403)
- `GET /api/backoffice/config` — `{ workspaceAppBaseUrl, workosEnvironmentId }` for external link building
- `GET /api/backoffice/workspaces` — full registry list with member counts
- `GET /api/backoffice/workspaces/:id` — workspace + owner detail
- `GET /api/backoffice/workspace-owner-invitations` — invitations with accepted-invite → workspace ref resolution
- `POST /api/backoffice/workspace-owner-invitations` — send a new app-level WorkOS invitation
- `POST /api/backoffice/workspace-owner-invitations/:id/resend` — resend
- `POST /api/backoffice/workspace-owner-invitations/:id/revoke` — revoke

**Internal endpoints (called by workspace router and regional backend):**

- `GET /internal/workspaces/:id/region` — resolve workspace region (used by router on KV miss)
- `GET /internal/workspaces/:workspaceId/members/:workosUserId` — confirm membership (regional backend self-heals a missing `users` row when its DB drifted behind the control plane)
- `POST /internal/invitation-shadows` — create invitation shadow (called by backend)
- `PATCH /internal/invitation-shadows/:id` — update invitation shadow

**Workspace creation flow:**

1. User calls `POST /api/workspaces` with a name and selected region
2. Control plane stores workspace record in its database
3. Outbox event triggers `provisionRegional` — calls the regional backend's `POST /internal/workspaces`
4. Outbox event triggers `syncToKv` — writes the workspace-to-region mapping to Cloudflare KV

---

## Backend

**What:** Regional application server running core domain logic — messaging, streams, AI agents, search, memos, file processing, and real-time event delivery.

**Deployed on:** Railway (auto-deploy on push to `main`). Docker image from `Dockerfile.backend`.

**Deploy trigger:** Automatic on merge to `main`.

**Key infrastructure dependencies:**

- PostgreSQL 17 + pgvector (regional `railway` database) — all domain data, event sourcing, job queue, outbox
- AWS S3 (regional bucket, e.g. `eu-north-1`) — file uploads (avatars, attachments)
- OpenRouter — AI model gateway (routes to Anthropic, OpenAI, etc.)
- WorkOS — session cookie validation (shared auth with control plane)
- Langfuse — AI observability/telemetry (OTEL-based)

**Talks to:**

- Control plane (create/update invitation shadows via internal endpoints)
- Frontend clients (HTTP API on port 8080 via Railway, WebSocket on `wss://ws-eu.threa.io`)

**Internal endpoints (called by control plane):**

- `POST /internal/workspaces` — provision a new workspace in this region
- `POST /internal/invitations/:id/accept` — accept an invitation

**Key subsystems:**

| Subsystem               | What it does                                                                     |
| ----------------------- | -------------------------------------------------------------------------------- |
| Express HTTP API        | REST endpoints for all domain features, validated with Zod                       |
| Socket.io               | Real-time event delivery, room-based broadcasting, cookie auth                   |
| Outbox dispatcher       | PostgreSQL NOTIFY/LISTEN; fans out committed events to 14 handlers               |
| Job queue               | PostgreSQL-backed background processing (AI, embeddings, file processing)        |
| Event sourcing          | `stream_events` as append-only log, `messages` as read projection                |
| AI wrapper (`createAI`) | Unified interface over Vercel AI SDK + LangChain, with cost tracking and budgets |

**Feature domains:** messaging, streams, agents (companion/persona/researcher), memos (GAM), search (semantic + text), attachments, conversations, invitations, activity feed, commands, emoji, AI usage tracking, user preferences, workspaces.

---

## Inter-Service Authentication

Services authenticate to each other using a shared `INTERNAL_API_KEY` sent in the `X-Internal-API-Key` header. User-facing auth uses WorkOS session cookies set on `.threa.io` so they're valid across subdomains. The cookie name is env-driven via `SESSION_COOKIE_NAME` (`wos_session` in prod, `wos_session_staging` in staging) so prod and staging sessions don't collide on the shared parent domain.

```
Browser -> Workspace Router:    Cookie (session cookie, name per env)
Browser -> Backoffice Router:   Cookie (session cookie, name per env)
Workspace Router -> Control Plane:   Cookie passthrough + INTERNAL_API_KEY (for /internal/*)
Workspace Router -> Backend:         Cookie passthrough
Backoffice Router -> Control Plane:  Cookie passthrough + X-Threa-Host (for per-host WorkOS redirect; survives Railway)
Control Plane -> Backend:            INTERNAL_API_KEY
Backend -> Control Plane:            INTERNAL_API_KEY
Browser -> Backend (WebSocket):      Cookie (session cookie, name per env)
```

---

## Infrastructure Summary

| Infrastructure           | Used by                                                    | Purpose                                                                                                                           |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Pages         | Frontend, Backoffice (prod + staging)                      | Static SPA hosting                                                                                                                |
| Cloudflare Workers       | Workspace Router, Backoffice Router (prod + staging)       | Edge API routing                                                                                                                  |
| Cloudflare KV            | Workspace Router, Control Plane                            | Workspace-to-region cache                                                                                                         |
| Railway                  | Backend, Control Plane, PostgreSQL                         | Application hosting                                                                                                               |
| PostgreSQL 17 + pgvector | Backend (`railway` db), Control Plane (`control_plane` db) | All persistent state                                                                                                              |
| AWS S3                   | Backend                                                    | File storage (per-region buckets)                                                                                                 |
| OpenRouter               | Backend                                                    | AI model gateway                                                                                                                  |
| WorkOS                   | Control Plane, Backend                                     | Authentication (OAuth/SSO) — backoffice uses the same client via `WORKOS_DEDICATED_REDIRECT_HOSTS` per-host redirect URI override |
| Langfuse                 | Backend                                                    | AI telemetry and observability                                                                                                    |

---

## Multi-Region Design

The architecture is designed for multi-region from the start, though currently only `eu-north-1` is active:

- Each region gets its own Railway backend instance with its own PostgreSQL database and S3 bucket
- The control plane is global and assigns workspaces to regions at creation time
- The workspace router resolves regions at the edge via Cloudflare KV and proxies to the correct backend
- WebSocket connections go directly to the regional backend (no routing through Workers)
- Terraform in `infra/aws/` defines per-region S3 infrastructure (`us-east-1` module exists but is commented out)
