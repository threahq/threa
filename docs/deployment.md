# Deployment

How production deploys work for each component of the Threa stack.

## Overview

| Component                   | Platform           | Trigger                                                           | URL                                            |
| --------------------------- | ------------------ | ----------------------------------------------------------------- | ---------------------------------------------- |
| Backend                     | Railway            | Auto-deploy on push to `main`                                     | `backend-production-6634.up.railway.app`       |
| Control-plane               | Railway            | Auto-deploy on push to `main`                                     | `control-plane-production-7495.up.railway.app` |
| PostgreSQL (prod)           | Railway            | Manual (watch patterns restrict to `Dockerfile.postgres` changes) | `postgres.railway.internal:5432`               |
| Workspace-router            | Cloudflare Workers | Auto-deploy on push to `main` (via `deploy-cloudflare.yml`)       | `app.threa.io/api/*`                           |
| Frontend                    | Cloudflare Pages   | Auto-deploy on push to `main` (via `deploy-cloudflare.yml`)       | `app.threa.io`                                 |
| Backoffice-router           | Cloudflare Workers | Auto-deploy on push to `main` (via `deploy-cloudflare.yml`)       | `admin.threa.io/*`                             |
| Backoffice                  | Cloudflare Pages   | Auto-deploy on push to `main` (via `deploy-cloudflare.yml`)       | `admin.threa.io`                               |
| Backoffice-router (staging) | Cloudflare Workers | Auto-deploy on push to `main` (via `deploy-cloudflare.yml`)       | `admin-staging.threa.io/*`                     |
| Backoffice (staging)        | Cloudflare Pages   | Auto-deploy on push to `main` (via `deploy-cloudflare.yml`)       | `admin-staging.threa.io`                       |
| Frontend (staging)          | Cloudflare Pages   | Auto-deploy on push to `main` (via `deploy-cloudflare.yml`)       | `staging.threa.io`                             |
| Workspace-router (staging)  | Cloudflare Workers | Auto-deploy on push to `main` (via `deploy-cloudflare.yml`)       | `staging.threa.io/api/*`, `pr-N-staging.*`     |

## Railway Services (Auto-Deploy)

Backend and control-plane auto-deploy when commits land on `main`. Railway watches the GitHub repo and builds from their respective Dockerfiles.

### Build Process

Both services use Bun and share the same build pattern:

1. Railway detects the push and starts a Docker build with repo root as context
2. The Dockerfile copies workspace `package.json` files first (cache-friendly layer ordering)
3. `bun install --frozen-lockfile --production` installs dependencies
4. Source code is copied (workspace packages + the app)
5. Container starts with `bun apps/<service>/src/index.ts`

```
Dockerfile.backend       → backend service
Dockerfile.control-plane → control-plane service
```

No explicit build step — Bun runs TypeScript directly.

#### Workspace `COPY` discipline

Both Dockerfiles enumerate every monorepo workspace `package.json` via explicit `COPY` lines (no glob), e.g.:

```dockerfile
COPY apps/backend/package.json apps/backend/
COPY apps/backoffice/package.json apps/backoffice/
COPY packages/types/package.json packages/types/
…
```

**Every** workspace under `apps/*` and `packages/*` must be copied — even ones the service doesn't actually use at runtime — because the root `bun.lock` references all of them via the `"workspaces": ["apps/*", "packages/*"]` glob in `package.json`. If a workspace exists in the lockfile but is missing on disk inside the build context, `bun install --frozen-lockfile` tries to mutate the lockfile to drop it and dies with:

```
error: lockfile had changes, but lockfile is frozen
```

This bit prod once during the backoffice rollout (PR #338) — adding `apps/backoffice` and `apps/backoffice-router` to the workspace set without updating the Dockerfiles took both backend and control-plane down at the next Railway rebuild.

A lint check enforces this from CI now: `bun run check:dockerfiles` (also part of the root `lint` script and the `lint` job in `.github/workflows/ci.yml`) compares the workspace package.json set on disk against each Dockerfile's `COPY` block and fails with the exact missing line if there's a mismatch. **When you add a new workspace under `apps/` or `packages/`, the lint will tell you which Dockerfiles need a new COPY line.**

### Migrations

Both services run database migrations automatically on startup before accepting traffic:

- **Backend**: `apps/backend/src/db/migrations/*.sql` → runs against `railway` database
- **Control-plane**: `apps/control-plane/src/db/migrations/*.sql` → runs against `control_plane` database

Migrations acquire a PostgreSQL advisory lock to prevent concurrent execution during rolling deploys. They are append-only (no down migrations).

### Health Checks

Railway polls these endpoints to determine when a deployment is ready:

- Backend: `GET /health` → `{ status: "ok" }`
- Control-plane: `GET /health` → `{ status: "ok" }`

The `/readyz` endpoint provides more detail (pool stats) but isn't used for Railway health checks.

### What Triggers a Deploy

Any push to `main` triggers a rebuild of **both** backend and control-plane. Railway doesn't have per-service watch paths for repo-linked services — both rebuild even if only one changed.

The PostgreSQL service has watch patterns set to `["Dockerfile.postgres"]`, so it only rebuilds when the Dockerfile itself changes (not on regular code pushes).

### Deploy Sequence

On push to `main`:

1. Railway queues builds for backend and control-plane in parallel
2. Each service builds its Docker image (~60-90s)
3. New container starts, runs migrations, begins listening
4. Railway health check passes → traffic shifts to new container
5. Old container receives SIGTERM → graceful shutdown (drains connections, closes pools)

Zero-downtime: Railway keeps the old container running until the new one passes health checks.

## PostgreSQL

PostgreSQL uses a custom Dockerfile (`Dockerfile.postgres`) that extends Railway's Postgres 17 image with pgvector:

```dockerfile
FROM ghcr.io/railwayapp-templates/postgres-ssl:17
RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-17-pgvector \
    && rm -rf /var/lib/apt/lists/*
```

Data persists on a Railway volume across container restarts.

**Watch patterns** are set to `["Dockerfile.postgres"]` so the database container only rebuilds when the Dockerfile changes. Without this, every push to `main` would restart the database and drop all connections.

Both services share the same PostgreSQL instance but use different databases:

- Backend → `railway`
- Control-plane → `control_plane`

## Cloudflare (Workers + Pages)

All Cloudflare surfaces auto-deploy on push to `main` via `.github/workflows/deploy-cloudflare.yml`. The workflow fires on `workflow_run` after CI passes and runs eight parallel deploy jobs:

| Job                                | Resource                                | What it does                                                                   |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `deploy-frontend`                  | `threa-frontend` (CF Pages)             | builds `apps/frontend` and pushes `dist/` to the prod Pages project            |
| `deploy-workspace-router`          | `workspace-router` (CF Worker)          | `wrangler deploy --config wrangler.production.toml`                            |
| `deploy-backoffice`                | `threa-backoffice` (CF Pages)           | builds `apps/backoffice` and pushes to the Pages project                       |
| `deploy-backoffice-router`         | `backoffice-router` (CF Worker)         | `wrangler deploy --config wrangler.production.toml`                            |
| `deploy-backoffice-staging`        | `threa-backoffice-staging` (CF Pages)   | builds `apps/backoffice` and pushes the same bundle to the staging project     |
| `deploy-backoffice-router-staging` | `backoffice-router-staging` (CF Worker) | `wrangler deploy --config wrangler.staging.toml`                               |
| `deploy-frontend-staging`          | `threa-staging` (CF Pages)              | builds `apps/frontend` and pushes to the staging Pages project (`main` branch) |
| `deploy-workspace-router-staging`  | `workspace-router-staging` (CF Worker)  | `wrangler deploy --config wrangler.staging.toml`                               |

The PR-staging workflow (`staging.yml`) deploys the same `threa-staging` Pages
project but with `--branch pr-N` to give each PR an isolated preview at
`pr-N-staging.threa.io`. The new `deploy-frontend-staging` job above keeps the
`main` branch of `threa-staging` (served at `staging.threa.io`) in sync as PRs
land — without it, the always-on staging environment fossilizes on whatever
build was last manually pushed.

### Workspace-router (`apps/workspace-router/`)

Routes user-app traffic on `app.threa.io/api/*`.

- **Config**: `wrangler.production.toml` carries `REGIONS` (JSON mapping region names → backend URLs), `CONTROL_PLANE_URL`, and a `WORKSPACE_REGIONS` KV namespace binding for workspace→region caching.
- **Secrets**: `INTERNAL_API_KEY` is set out-of-band via `bunx wrangler secret put INTERNAL_API_KEY --config wrangler.production.toml`.
- **Route binding**: configured in the Cloudflare dashboard (Workers Routes for the `threa.io` zone).
- **What it routes**:

| Pattern                       | Destination                               |
| ----------------------------- | ----------------------------------------- |
| `/api/auth/*`                 | Control-plane                             |
| `/api/workspaces` (GET, POST) | Control-plane                             |
| `/api/regions`                | Control-plane                             |
| `/api/workspaces/:id/config`  | Returns `{ region, wsUrl }` directly      |
| `/api/workspaces/:id/*`       | Regional backend (looked up via KV cache) |
| `/readyz`                     | Returns 200 (local health check)          |

### Frontend (`apps/frontend/`)

React 19 + Vite SPA deployed to the `threa-frontend` Cloudflare Pages project.

- **SPA routing**: `apps/frontend/public/_redirects` contains `/* /index.html 200`.
- **Domain sharing**: frontend and workspace-router share `app.threa.io`. Workers Routes take priority over Pages, so `/api/*` → workspace-router and everything else → Pages.
- **API base URL**: relative paths only (`fetch("/api/...")`). No configurable base.

### Backoffice (`apps/backoffice/`)

Internal admin tool — second React 19 + Vite SPA, separate deployment from the main frontend, served at `admin.threa.io` (prod) and `admin-staging.threa.io` (staging).

- **CF Pages projects**: `threa-backoffice` (prod) and `threa-backoffice-staging` (staging).
- **No `app.threa.io` sharing**: lives on its own dedicated subdomain to keep it auditable and to give it its own router worker (see below).
- **Same SPA routing trick**: relies on the backoffice-router worker to serve `index.html` for non-API paths.

### Backoffice-router (`apps/backoffice-router/`)

Tiny CF Worker (~100 lines) that fronts the backoffice. Independent of `workspace-router` so the backoffice doesn't inherit workspace-routing concerns.

- **Routes**: declarative in `wrangler.production.toml` and `wrangler.staging.toml` — `admin.threa.io/*` and `admin-staging.threa.io/*` respectively. Every deploy re-provisions the binding (no hidden dashboard state).
- **Proxies**:
  - `/api/*` and `/test-auth-login*` → control-plane
  - `/readyz` → returns `200 OK` directly
  - everything else → `threa-backoffice.pages.dev` (or `threa-backoffice-staging.pages.dev`) via the `PAGES_PROJECT` env var
- **Security posture** (mirrors workspace-router): trust only `CF-Connecting-IP`, strip client-supplied `X-Forwarded-For` to prevent rate-limit bypass on the control-plane, set `X-Forwarded-Host`/`-Proto` plus the custom `X-Threa-Host` header (the real client host the control-plane actually reads — see `WORKOS_DEDICATED_REDIRECT_HOSTS` below for why `X-Forwarded-Host` can't be used).
- **Why a router instead of binding the Pages project to `admin.threa.io` directly**: same-origin proxying through the worker means the WorkOS session cookie lands on `admin.threa.io` directly with no `SameSite` cross-origin pain. The control-plane handles the per-host redirect URI override via `WORKOS_DEDICATED_REDIRECT_HOSTS` (see env vars below).

### DNS

All four subdomains are CNAMEs into the matching CF Pages project, proxied (orange-cloud) on the `threa.io` zone:

| Subdomain                | CNAME target                             |
| ------------------------ | ---------------------------------------- |
| `app.threa.io`           | bound directly to `threa-frontend` Pages |
| `admin.threa.io`         | `threa-backoffice.pages.dev`             |
| `admin-staging.threa.io` | `threa-backoffice-staging.pages.dev`     |

The CNAME target is largely cosmetic for the admin subdomains because the Workers Route on `admin*.threa.io/*` intercepts traffic at the edge before it reaches the Pages origin.

### Manual deploy fallback

If CI is unavailable, every CF surface can be deployed by hand from the relevant directory:

```bash
# Workers
cd apps/workspace-router && bunx wrangler deploy --config wrangler.production.toml
cd apps/backoffice-router && bunx wrangler deploy --config wrangler.production.toml
cd apps/backoffice-router && bunx wrangler deploy --config wrangler.staging.toml

# Pages
cd apps/frontend && bun run build && bunx wrangler pages deploy dist --project-name threa-frontend --branch main
cd apps/backoffice && bun run build && bunx wrangler pages deploy dist --project-name threa-backoffice --branch main
cd apps/backoffice && bun run build && bunx wrangler pages deploy dist --project-name threa-backoffice-staging --branch main
```

## Inter-Service Communication

All services communicate over Railway's private network at port **8080** (Railway's injected PORT):

```
Frontend (app.threa.io)                           Backoffice (admin.threa.io)
    │                                                 │
    ├─ /api/auth/* ──────────► Workspace-Router       ├─ /api/* ─► Backoffice-Router ─► Control-plane (:8080)
    │                              │                  │
    │                              ▼                  └─ /  ─────► Backoffice-Router ─► threa-backoffice.pages.dev
    │                          Control-plane (:8080)
    │
    ├─ /api/workspaces/* ────► Workspace-Router ──► Regional backend (:8080)
    └─ wss://ws-eu.threa.io ► Backend directly (cookie auth)

Control-plane ◄──────────────► Backend (bidirectional over :8080)
    │                              │
    └── REGIONS config             └── CONTROL_PLANE_URL
        internalUrl:8080               http://cp.railway.internal:8080
```

Key env vars for inter-service wiring:

| Service       | Variable            | Value                                                                   |
| ------------- | ------------------- | ----------------------------------------------------------------------- |
| Backend       | `CONTROL_PLANE_URL` | `http://control-plane.railway.internal:8080`                            |
| Control-plane | `REGIONS`           | `{"eu-north-1":{"internalUrl":"http://backend.railway.internal:8080"}}` |
| Both          | `INTERNAL_API_KEY`  | Shared secret for auth header                                           |

**Critical:** Railway services always listen on port 8080 regardless of the `EXPOSE` directive in Dockerfiles. Internal URLs must use `:8080`.

## CI Pipeline

GitHub Actions runs on every PR and push to `main`:

### CI (`.github/workflows/ci.yml`)

- Lints frontend (ESLint)
- Runs `bun run check:dockerfiles` to verify every workspace `package.json` is COPY-ed into each Dockerfile that runs `bun install --frozen-lockfile` (see the workspace COPY discipline section above)
- Runs full test suite against Postgres 17 + pgvector + MinIO
- Backend unit/integration tests, control-plane tests, workspace-router tests, frontend tests

### Browser Tests (`.github/workflows/browser-tests.yml`)

- Playwright E2E tests in Chromium
- Sharded across 2 parallel runners
- Runs on push to `main` and PRs

### Cloudflare deploy (`.github/workflows/deploy-cloudflare.yml`)

- Fires on `workflow_run` after CI completes successfully on `main`
- Six parallel jobs deploy frontend, workspace-router, backoffice (prod), backoffice-router (prod), backoffice (staging), and backoffice-router (staging) — see the Cloudflare section above

CI and Browser Tests must pass before merging. The deploy workflow is best-effort post-merge.

## Environment Variables

See `.env.example` at the repo root for the full list with descriptions. The critical production-only variables are:

### Backend

| Variable                                                             | Description                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| `DATABASE_URL`                                                       | PostgreSQL connection string                            |
| `NODE_ENV`                                                           | `production`                                            |
| `CORS_ALLOWED_ORIGINS`                                               | `https://app.threa.io`                                  |
| `COOKIE_DOMAIN`                                                      | `.threa.io` (prod and staging)                          |
| `SESSION_COOKIE_NAME`                                                | `wos_session` in prod, `wos_session_staging` in staging |
| `WORKOS_API_KEY`                                                     | WorkOS API key                                          |
| `WORKOS_CLIENT_ID`                                                   | WorkOS OAuth client ID                                  |
| `WORKOS_REDIRECT_URI`                                                | `https://app.threa.io/api/auth/callback`                |
| `WORKOS_COOKIE_PASSWORD`                                             | 32+ char secret for sealed sessions                     |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | AWS S3 for file uploads                                 |
| `OPENROUTER_API_KEY`                                                 | AI model access                                         |
| `CONTROL_PLANE_URL`                                                  | `http://control-plane.railway.internal:8080`            |
| `INTERNAL_API_KEY`                                                   | Shared inter-service secret                             |
| `REGION`                                                             | `eu-north-1`                                            |

### Control-Plane

| Variable                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                    | PostgreSQL connection string (uses `control_plane` database)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `NODE_ENV`                        | `production`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `CORS_ALLOWED_ORIGINS`            | Comma-separated. Prod: `https://app.threa.io,https://admin.threa.io`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `COOKIE_DOMAIN`                   | `.threa.io` in prod and staging. In staging this is what lets PR subdomains (`pr-204-staging.threa.io`) see the session set during the callback at `staging.threa.io`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SESSION_COOKIE_NAME`             | `wos_session` in prod, `wos_session_staging` in staging. Must differ between envs that share `COOKIE_DOMAIN=.threa.io`, otherwise logging into one clobbers the other in the same browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WORKOS_*`                        | Same 4 WorkOS values as backend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `INTERNAL_API_KEY`                | Same shared secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `REGIONS`                         | JSON with regional backend internal URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CLOUDFLARE_KV_*`                 | Cloudflare KV credentials for workspace→region cache sync                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `FRONTEND_URL`                    | `https://app.threa.io`. Used for post-auth redirects AND surfaced through `/api/backoffice/config` so the backoffice UI can render `/ws/:id` deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PLATFORM_ADMIN_WORKOS_USER_IDS`  | Comma-separated WorkOS user IDs that get auto-seeded into `platform_roles` with `role='admin'` on startup. Without this, the backoffice's "Not authorised" gate fires for everybody.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `WORKOS_ENVIRONMENT_ID`           | `environment_<ULID>`. Surfaced through `/api/backoffice/config` so the workspace detail page can render the WorkOS dashboard link. The WorkOS Node SDK has no introspection API for this — it lives only in the dashboard URL — so it has to be set explicitly per environment. Optional; null → backoffice falls back to plain mono text.                                                                                                                                                                                                                                                                                                 |
| `WORKOS_DEDICATED_REDIRECT_HOSTS` | Comma-separated. `admin.threa.io` in prod. Tells the control-plane to send `https://${host}/api/auth/callback` as the WorkOS redirect URI when the request came in via the backoffice-router, instead of the default `WORKOS_REDIRECT_URI`. Cleaner than relying on cookie-domain sharing for the post-callback redirect. The "request came in via host X" signal is the custom `X-Threa-Host` header the routers set — **not** `X-Forwarded-Host`, which Railway's edge proxy overwrites with its own ingress hostname before the control-plane sees it (which silently disabled this override and bounced admin logins to the main app). |

## Rollback

### Railway Services

Railway keeps deployment history. To roll back:

```bash
railway redeploy --service backend --yes    # rebuild from same commit
```

Or use the Railway dashboard to redeploy a previous deployment.

### Cloudflare Workers

```bash
git checkout <previous-commit>

# workspace-router
cd apps/workspace-router
bunx wrangler deploy --config wrangler.production.toml

# backoffice-router (prod and staging)
cd ../backoffice-router
bunx wrangler deploy --config wrangler.production.toml
bunx wrangler deploy --config wrangler.staging.toml
```

### Cloudflare Pages

```bash
git checkout <previous-commit>

# frontend
cd apps/frontend
bun run build
bunx wrangler pages deploy dist --project-name threa-frontend --branch main

# backoffice (prod and staging)
cd ../backoffice
bun run build
bunx wrangler pages deploy dist --project-name threa-backoffice --branch main
bunx wrangler pages deploy dist --project-name threa-backoffice-staging --branch main
```

### Database Migrations

Migrations are append-only and forward-only. To undo a migration, write a new migration that reverses the change.
