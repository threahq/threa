# Threa

Threa is a workplace chat application (channels, threads, DMs, scratchpads) with
an automatic memory layer that extracts decisions and context from conversations
into searchable notes linked back to their source messages.

- Website: [threa.io](https://threa.io)
- App: [app.threa.io](https://app.threa.io)

## Memory (GAM)

The memory layer is **GAM (General Agentic Memory)**. As messages arrive, GAM
classifies them, extracts the ones that record a decision or its context, and
stores each as a **memo**: a short summary that links back to the messages it was
derived from. Memos are indexed for full-text and vector (semantic) search and
are retrieved automatically when a related topic comes up.

## Ariadne

Ariadne is the built-in conversational agent, available in any stream. It answers
from memos and their source messages, citing links and timestamps. Its behavior
is configurable per stream via personas.

Threa also exposes a read API over the workspace with scoped keys (memos as JSON,
messages as markdown), so an external agent can read the same data Ariadne does.

## Features

- **Scratchpads.** Personal, AI-assisted notes; the default entry point for solo
  use.
- **Channels.** Public or private team conversations.
- **Direct messages.** One-on-one chat.
- **Threads.** Nested discussions off any message, including threads within
  threads; a message can be moved into a thread after the fact.
- **Quote replies.** Inline quotes of a specific line.
- **Markdown composer.** Fenced code with syntax highlighting, a full-screen
  editor, and saved drafts.
- **Memos.** Decisions and context extracted from conversations (GAM).
- **Search.** Full-text and semantic search with filters.
- **End-to-end encryption.** Opt-in per conversation; encrypted streams store
  only ciphertext and are excluded from memo extraction.

## Architecture

Threa is a Bun monorepo. The request path for the main app:

```text
Browser ──→ Frontend (Cloudflare Pages)
        ──→ Workspace Router (Cloudflare Worker) ──→ Control Plane
                                                 ──→ Regional Backend
        ──→ WebSocket (direct to Regional Backend)
```

- **Frontend** (`apps/frontend`). React 19 + Vite SPA on Cloudflare Pages.
  Real-time updates over Socket.io; offline drafts in IndexedDB.
- **Workspace Router** (`apps/workspace-router`). Cloudflare Worker that routes
  `/api/*`: auth, workspace creation, and `/api/regions` go to the control plane,
  and `/api/workspaces/:id/*` to the right regional backend (resolved from
  Cloudflare KV). It answers `GET /api/workspaces/:id/config` directly with
  `{ region, wsUrl }`, which the frontend uses to open its WebSocket.
- **Control Plane** (`apps/control-plane`). Global service for authentication
  (WorkOS), workspace creation, and region assignment. Runs on Railway with its
  own PostgreSQL database.
- **Backend** (`apps/backend`). Regional application server for all domain logic:
  messaging, streams, agents, memos, search, and files. PostgreSQL 17 with
  pgvector, AWS S3 for files, OpenRouter as the model gateway. Event sourcing
  with an outbox pattern drives real-time delivery.
- **Enclave** (`apps/enclave`). Runs Ariadne for end-to-end encrypted
  scratchpads. Holds no database credentials and never logs payload contents.
- **Backoffice** (`apps/backoffice`, `apps/backoffice-router`). Internal
  platform-admin SPA and its edge router, gated to platform admins.

Shared code lives in `packages/`: domain types and API contracts (`types`), the
ProseMirror editor wrapper (`prosemirror`), backend infrastructure
(`backend-common`), the agent runtime (`agent-runtime`), and encryption
primitives (`crypto`).

The design is multi-region: each region gets its own backend, database, and
storage, though a single region is active today.

## Development

Threa uses [Bun](https://bun.sh).

```bash
bun install
bun run db:start   # PostgreSQL + MinIO via Docker
bun run dev        # all services
```

The app comes up at `http://localhost:5173`.

```bash
bun run test       # unit/integration (backend)
bun run test:e2e   # end-to-end
bun run typecheck  # types across the monorepo
bun run lint
```

Architecture and conventions are documented in [`docs/`](docs/). Start with
[`docs/system-overview.md`](docs/system-overview.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/core-concepts.md`](docs/core-concepts.md). Code constraints live in
[`CLAUDE.md`](CLAUDE.md).
