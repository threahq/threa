# Threa

Workplace chat that remembers.

Website: [threa.io](https://threa.io) · App: [app.threa.io](https://app.threa.io)

Channels, threads, and DMs, with a memory underneath. The decisions you make and
the reasons behind them stay attached to the conversation, so they're still
there when the question comes up again.

## The problem

Decisions get made in chat and then scroll away. Two months later someone asks
why a project was paused, nobody can find the thread, and the discussion happens
again. The reasoning was there; it just wasn't reachable.

## How memory works

Threa reads the conversation, finds the part where a decision actually gets
settled, and keeps it as a short **memo** that links back to the messages it came
from. The subsystem that does this is **GAM (General Agentic Memory)**. Memos are
searchable by full text and by meaning (vector search), and they surface on their
own when the topic returns, without anyone remembering to go looking.

- **Capture.** Most of a channel is noise; the part worth keeping is usually a
  handful of lines. GAM finds those and writes a memo.
- **Hold.** The memo is short and sourced, so it stays useful after the thread
  has scrolled away.
- **Return.** When the topic comes up again, the relevant memos come with it.

## Ariadne

Ariadne is the built-in agent, available in any conversation. Ask it why
something was decided and it answers from the memos and their source messages,
with links and timestamps. Personas let you adjust how it behaves per stream.

You can also bring your own agent. Threa exposes a read API over your workspace
with scoped keys: memos come back as JSON, messages as markdown, so Claude,
Cursor, or your own setup can read the same memory Ariadne does.

## Features

- **Scratchpads.** Personal, AI-assisted notes. Threa starts solo, with
  scratchpads as the entry point rather than channels.
- **Channels.** Public or private team conversations.
- **Direct messages.** One-on-one chat.
- **Threads.** Nested discussions off any message, including threads inside
  threads. A stray reply can be moved into a thread after the fact.
- **Quote replies.** Reply to the exact line someone wrote, quoted inline.
- **Markdown composer.** Fenced code with syntax highlighting, a full-screen
  editor, and a stash for half-written messages.
- **Memos.** Decisions and context extracted from conversations (GAM).
- **Search.** Full-text and semantic search with filters.
- **End-to-end encryption.** Turn it on for sensitive conversations. Threa keeps
  only ciphertext for those, and they don't become memos.

## Architecture

Threa is a Bun monorepo. The request path for the main app:

```
Browser ──→ Frontend (Cloudflare Pages)
        ──→ Workspace Router (Cloudflare Worker) ──→ Control Plane
                                                 ──→ Regional Backend
        ──→ WebSocket (direct to Regional Backend)
```

- **Frontend** (`apps/frontend`). React 19 + Vite SPA on Cloudflare Pages.
  Real-time updates over Socket.io; offline drafts in IndexedDB.
- **Workspace Router** (`apps/workspace-router`). Cloudflare Worker that routes
  `/api/*` to the control plane (auth, workspace creation) or the right regional
  backend, resolving workspace-to-region from Cloudflare KV.
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
