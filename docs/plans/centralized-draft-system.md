# Centralized Draft System

## Problem

Drafts in Threa are local-only. The composer auto-saves what you type to IndexedDB (`db.draftMessages`, keyed by `stream:{streamId}` / `thread:{parentMessageId}`, debounced 500ms via `use-draft-message.ts`) and lets you keep extra manual saves per scope (`db.stashedDrafts`, Cmd+S). None of it leaves the device.

That breaks the core promise of "pick your work up from anywhere." A reply you start on your phone is invisible on your laptop. Worse, there is no safe story for the same draft being touched on two devices — the cardinal sin we must avoid is a user losing changes made on their phone because something overwrote them from a stale laptop tab.

We want drafts to be **centralized but local-first**: they live in IndexedDB and render instantly, and a debounced background push mirrors them to the backend so they roam across devices. Concurrency is resolved by the simplest safe rule — **local wins, and on drift we split** rather than overwrite. Duplicated drafts are acceptable; lost drafts are not.

## Goal

1. Every draft is a first-class entity (`draft_xxx`) owned by a user, scoped to a stream or a not-yet-threaded parent message, carrying a monotonic `version`.
2. Writes hit IndexedDB first (instant, offline-tolerant); a debounced push mirrors to the backend through the existing offline operation queue, with **silent retry and no error surfaces** — a failed remote save never interrupts the user because the local copy stands.
3. Concurrency uses optimistic locking on `version`. On a version conflict the backend **splits** (keeps the existing row, inserts a new draft from the incoming content) instead of rejecting. The same drift rule runs client-side against incoming socket events. Neither side ever overwrites.
4. Drafts sync reactively to the author's other devices via the outbox → `user:{userId}` socket room, paired with a bootstrap fetch (INV-53).
5. Drafts cover everything the composer can hold: text (`contentJson`), attachments, slash commands, quote/share refs, context refs — and the E2E ciphertext variant for encrypted streams.
6. Sending a message **resolves** its draft: the send carries `draftId + version`, and the draft is deleted CAS-safely so a drifted copy is never collaterally destroyed.
7. A draft that targets a not-yet-threaded message re-points to the thread stream when that message is converted to a thread.

## Non-goals

- **No merge UI / no conflict markers.** Split drafts appear plainly in the stash list, ordered by recency. No "from another device" badge (deferred; trivial to add later).
- **No real-time co-editing.** Drafts are single-author, last-writer-loaded per device. We sync entities, not keystrokes.
- **No syncing of the "loaded" pointer.** Which draft is checked out into the composer is device-local UI state and never travels to the backend or other devices. A fresh device opens the composer **empty**; the user picks a draft from the stash to load it.
- **No draft sharing across users.** Drafts are private to their author (INV-8, user-scoped). They are not timeline-broadcast and do not touch `TIMELINE_BROADCAST_EVENT_TYPES`.
- **No centralization of unpromoted draft-stream content** until the stream exists. A draft inside a not-yet-created scratchpad stays local until the existing `promoteDraft` flow creates the real stream, then it is re-scoped and pushed.
- **No retention/expiry policy** beyond resolve-on-send and explicit delete in v1.

## Terminology

- **Draft** — a single composer payload entity: `id` (`draft_xxx`), `scope`, content, `version`. The unit that syncs. Replaces both the old "active draft" and "stashed draft" notions — there is only one kind now.
- **Scope** — where a draft belongs: `stream:{streamId}` or `thread:{parentMessageId}` (the latter only while the reply target has no thread stream yet). A scope may hold multiple drafts (the loaded one plus stash entries plus any split-offs).
- **Loaded** — device-local state: which draft id (if any) is currently checked out into the composer for a scope. Persisted locally only, so reload restores it. Never synced.
- **Stash** — the set of a scope's drafts that are not currently loaded on this device. Not a separate store — just "every draft for this scope except the loaded one."
- **Drift** — the client has local edits made on top of `version N`, but the server (via another device) has already moved past `N`. Detected by `version` mismatch.
- **Split** — the conflict resolution: keep the existing row untouched, insert a new draft entity from the incoming content. Both survive.
- **Resolve** — clearing a draft on successful send, CAS-guarded by `version` so a drifted copy is not deleted.

## Architecture

### Where things live

- **Shared types** (`packages/types/`) — `Draft` domain type, `DraftScope`, `UpsertDraftInput` / `ResolveDraftInput` API contracts, outbox payload shapes, socket event names, draft id prefix.
- **Backend** (`apps/backend/src/features/drafts/`, INV-51/52) — `index.ts` barrel, `handlers.ts` (Zod validation, routes), `service.ts` (transaction boundaries, split logic), `repository.ts` (CAS upsert + split insert, snake↔camel, prefixed ULID), `outbox-handler.ts` (emit to `user:{userId}`), colocated tests. Routes wired in `routes.ts`; outbox type union extended in `lib/outbox/repository.ts`.
- **Thread re-pointing** — `messaging/event-service.ts` `moveMessagesToThread` re-scopes the user's `thread:{targetMessageId}` drafts in the same transaction.
- **Frontend** (`apps/frontend/src/`) — Dexie schema bump folding `draftMessages` + `stashedDrafts` into one `drafts` store plus a device-local `composerLoaded` pointer store; rewritten `use-draft-message.ts` / `draft-store.ts` / `use-stash-composer.ts`; new `operation-queue` op types; `sync/` socket handlers + bootstrap apply; send path carries `draftId + version`.

### Data model

Backend table (migration via `add-migration`; no FKs INV-1, no enums INV-3, workspace-scoped INV-8, prefixed ULID INV-2):

```sql
CREATE TABLE drafts (
  id              TEXT PRIMARY KEY,            -- draft_xxx
  workspace_id    TEXT NOT NULL,
  user_id         TEXT NOT NULL,              -- author; drafts are private (INV-8, INV-50 UserId)
  scope           TEXT NOT NULL,              -- "stream:{id}" | "thread:{messageId}"
  root_stream_id  TEXT,                       -- for access/cleanup; nullable for thread-by-message scope
  content_json    JSONB,                      -- null for E2E
  content_markdown TEXT,                      -- null for E2E
  attachment_ids  JSONB NOT NULL DEFAULT '[]',
  command         JSONB,                      -- { name, clientActionId } when the draft is a slash command
  context_refs    JSONB,                      -- "discuss-with-ariadne" chips
  ciphertext      TEXT,                       -- E2E only (base64)
  envelope        JSONB,                      -- E2E only
  e2e_version     INTEGER,                    -- E2E only
  version         INTEGER NOT NULL DEFAULT 1, -- optimistic lock; split-on-conflict
  client_updated_at TIMESTAMPTZ NOT NULL,     -- authoring device clock, drives recency ordering
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ                 -- soft delete = tombstone for cross-device removal
);

CREATE INDEX idx_drafts_user ON drafts (workspace_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_drafts_user_scope ON drafts (workspace_id, user_id, scope) WHERE deleted_at IS NULL;
CREATE INDEX idx_drafts_user_recency ON drafts (workspace_id, user_id, client_updated_at DESC) WHERE deleted_at IS NULL;
```

Frontend Dexie `drafts` store (one row per draft; replaces both old tables):

```ts
interface CachedDraft {
  id: string // draft_xxx (client-generated until first server confirm; stable after)
  workspaceId: string
  scope: string // "stream:{id}" | "thread:{messageId}"
  rootStreamId?: string
  contentJson?: JSONContent // plaintext (or decrypted) for render
  attachments: DraftAttachment[]
  command?: { name: string; clientActionId: string | null }
  contextRefs?: DraftContextRef[]
  // E2E at-rest: ciphertext stored, plaintext only after in-memory decrypt
  ciphertext?: string
  envelope?: unknown
  e2eVersion?: number
  version: number // last value this client intends/knows
  baseVersion: number // last server-confirmed version (basis for next expectedVersion)
  clientUpdatedAt: number
  _syncStatus: "dirty" | "pending" | "synced"
}

// device-local, never synced
interface ComposerLoaded {
  scope: string // primary key
  draftId: string | null
}
```

### The drift/split protocol

Mirrors the `scheduled_messages` integer-`version` optimistic lock (CAS in the `WHERE`), but **splits instead of 409**.

Upsert (`PUT /api/workspaces/:wid/drafts/:id`, body `{ scope, content…, expectedVersion, clientUpdatedAt }`). The client's "bump the version by one and send" is exactly `expectedVersion` = the version the edit was based on. Server, in one transaction, `SELECT … FOR UPDATE` the row by `(workspace, user, id)`:

1. **No row** → insert at `version 1`. Return `{ id, version: 1, split: false }`.
2. **`version === expectedVersion`** → CAS update content, `version = version + 1`. Return `{ id, version, split: false }`. (Happy path.)
3. **`version !== expectedVersion`** (drift) → **leave the existing row untouched** (the other device's content survives); insert a **new** draft (`newId`) from the incoming content at `version 1`, same scope. Return `{ id: newId, version: 1, split: true, originalId: id }`.

Each branch writes a `draft:upserted` outbox event scoped to the user.

Client on response:

- `split: false` → set `baseVersion = version`, mark `_syncStatus: "synced"`.
- `split: true` → migrate the local row id from `id` → `newId` (Dexie delete-old / put-new, the same atomic-swap shape as the optimistic-message reconcile in `stream-sync.ts`), repoint `composerLoaded` if it pointed at the old id, set `baseVersion`. The divergent original arrives as another stash row via its own socket event.

The **same rule runs client-side**: if a `draft:upserted` arrives for an id the client has unpushed local edits on, that is drift detected locally → the client splits locally (new local id for its own edits, accept the server row under the original id). This is why the logic must live in both places — a change can originate anywhere.

### Resolve-on-send

The send path carries `draftId + version`. After the message send succeeds, `DELETE /api/workspaces/:wid/drafts/:id` with `expectedVersion` (CAS): soft-delete only if `version` still matches; if it drifted, **do not delete** — it survives as a stash entry. `draft:deleted` outbox event removes it on other devices. Locally: clear the loaded pointer, enqueue the delete op (silent retry).

### Offline-first + silent retry

Every write hits Dexie first. The existing 500ms debounce enqueues `upsert_draft` / `resolve_draft` / `delete_draft` ops into `operation-queue.ts` (Web Locks + exponential backoff). Remote failures **never** surface a toast; the local copy stands and the op retries (INV: no silent fallback for real errors, but draft-save failures are explicitly non-fatal and user-invisible by design).

### E2E (encrypt-before-push)

For E2E streams, seal the draft payload to the stream SSK (reuse the `sealOutgoingMessage` path) before persisting and pushing. Ciphertext is stored locally too (honoring E2EE-4 "no plaintext at rest") and decrypted into the composer on load — so E2E drafts roam without ever writing plaintext to disk or wire.

### Reactive sync (INV-53)

`draft:upserted` / `draft:deleted` emit to `user:{userId}`. `GET /api/workspaces/:wid/drafts` bootstrap seeds the Dexie store, paired with the existing user-room subscription and invalidated on reconnect/resubscribe.

## Stage Sequence

Each stage is an independently mergeable PR with its own tests, sized for a clean handover between sessions. Run `bun run test` (and `test:e2e` where a stage touches the send/sync path) before handing off. Use the `handover` skill at each stage boundary.

### Stage 1 — Types + backend feature + migration

**Scope:** Backend only. No frontend wiring; the table and endpoints exist and are tested but nothing calls them yet.

**Changes:**

- `packages/types`: `Draft`, `DraftScope`, `UpsertDraftInput`, `ResolveDraftInput`, `DraftUpsertedOutboxPayload`, `DraftDeletedOutboxPayload`, socket event name constants, `draft_` id prefix.
- Migration `*_drafts.sql` (the table above).
- `apps/backend/src/features/drafts/`: `repository.ts` (CAS upsert + split insert + soft-delete + list-by-user, snake↔camel), `service.ts` (txn boundaries, split decision, outbox writes), `handlers.ts` (Zod schemas, `upsert` / `resolve` / `list`), `index.ts` barrel.
- `routes.ts`: mount `GET/PUT/DELETE /drafts`. `lib/outbox/repository.ts`: add `draft:upserted` / `draft:deleted` to the type union + payload interfaces. `outbox-handler.ts`: emit to `user:{userId}`.
- `lib/id.ts`: export `draftId()`.

**Reuse:** `scheduled_messages` repository for the CAS pattern; `withTransaction`; `OutboxRepository.insert`; existing user-room emit helpers.

**Verification:** Repository unit tests (insert / CAS-update / split-on-mismatch / soft-delete CAS); service tests (concurrent upsert → one updates, one splits; resolve declines on version mismatch). `bun run test --filter drafts`.

### Stage 2 — Frontend unified local store

**Scope:** Frontend only, local-first, **no backend calls yet**. App keeps working; drafts behave as today but through the new unified model.

**Changes:**

- Dexie version bump: add `drafts` + `composerLoaded` stores; upgrade fn migrates existing `draftMessages` rows (→ one draft each, loaded pointer set) and `stashedDrafts` rows (→ drafts, not loaded) into `drafts`. Drop the old stores after migration.
- Rewrite `use-draft-message.ts`, `draft-store.ts`, `use-stash-composer.ts` to the unified model: load = read `composerLoaded[scope]` (empty on fresh device); save = upsert local draft + set loaded pointer; stash list = scope's drafts minus loaded.
- `useDraftComposer` / `message-input.tsx`: load empty on fresh open, expose stash picker over the unified store.

**Reuse:** Existing debounce, `useLiveQuery` reactivity, stash-picker UI.

**Verification:** Frontend integration tests (INV-39): type → local draft persists; reload restores loaded draft; fresh scope opens empty; stash holds non-loaded drafts; migration upgrades old rows. `bun run test`.

### Stage 3 — Push/pull sync + client-side drift

**Scope:** Wire the local store to the backend through the offline queue and socket.

**Changes:**

- `operation-queue.ts`: add `upsert_draft` / `delete_draft` ops (silent retry, no error surface) and the response-reconcile (migrate id on `split: true`, set `baseVersion`).
- Debounced push enqueues `upsert_draft` with `expectedVersion = baseVersion`.
- `sync/`: `draft:upserted` / `draft:deleted` socket handlers (apply with client-side drift → local split when a server row collides with unpushed local edits); `GET /drafts` bootstrap apply + reconnect invalidation (INV-53).

**Reuse:** `operation-queue` backoff + Web Locks; `stream-sync.ts` atomic-swap reconcile shape; existing user-room subscription + bootstrap-on-reconnect plumbing.

**Verification:** Integration tests: type → push → server confirm sets `baseVersion`; simulated `draft:upserted` collision → local split (both rows present); offline → queue → retry on reconnect. Backend concurrent-upsert split test from Stage 1 still green. `bun run test`.

### Stage 4 — Resolve-on-send, thread re-pointing, E2E

**Scope:** Close the loop on the message lifecycle and encrypted streams.

**Changes:**

- Send path (`use-stream-or-draft.ts` / `message-input.tsx`): carry `draftId + version`; on send success enqueue `resolve_draft` (CAS delete), clear loaded pointer.
- `moveMessagesToThread` (`event-service.ts`): re-scope user's `thread:{targetMessageId}` drafts → `stream:{threadStreamId}` (+ `root_stream_id`) in the move transaction, emit `draft:upserted`. Frontend handler moves the local draft + loaded pointer. Fold the unpromoted-draft-stream case into the existing `promoteDraft` flow (re-scope + push on promotion).
- E2E: seal draft to stream SSK before persist/push; store ciphertext locally; decrypt on load.

**Reuse:** `sealOutgoingMessage` E2E path; existing `promoteDraft` / `setParentThreadId`; resolve CAS from Stage 1.

**Verification:** Backend test: resolve declines on drift, deletes on match; thread-conversion re-points drafts. Frontend/E2E (`test:e2e`): send clears draft; drifted draft survives send; reply draft follows a message into its new thread; E2E draft round-trips without plaintext at rest. `bun run test` + `bun run test:e2e`.

## Invariant Notes

- INV-1/2/3/8/50: drafts are workspace- + user-scoped, prefixed-ULID, no FKs/enums.
- INV-20: writes are race-safe via `version` CAS; split-on-conflict is the documented resolution, never select-then-overwrite.
- INV-4/6/7: backend mutations + outbox in one transaction; services own transactions.
- INV-51/52: colocated `drafts` feature, barrel-exported.
- INV-53: socket subscription paired with bootstrap, invalidated on reconnect.
- INV-58: `contentJson` is canonical internally; markdown only at the API boundary.
- E2EE-4: no plaintext draft at rest; E2E drafts persist ciphertext only.
- Not in `TIMELINE_BROADCAST_EVENT_TYPES`: draft events are user-private, not timeline rows.
