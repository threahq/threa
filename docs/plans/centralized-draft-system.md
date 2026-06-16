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
  - **Drafts-view implication (flagged 2026-06-14, kris):** the `/drafts` explorer (`useAllDrafts` → `pages/drafts.tsx`) is genuinely **live** for channel/DM/thread message drafts — they read `db.drafts`, which Stage 3 seeds from `GET /drafts` and keeps current over the `user:{userId}` socket (verified end-to-end: `workspace-layout.tsx` provides `draftsService.list`, `SyncEngine.syncDrafts` bootstraps on connect, `workspace-sync.ts` handles `draft:upserted`/`draft:deleted`). But unpromoted **scratchpad** drafts (`db.draftScratchpads`, no version/sync fields, never enqueued) are **local-only** by this non-goal, and since scratchpads are the solo-first primary entry point they are the bulk of a typical Drafts view — so the view _reads_ as "local-only" even though message drafts roam. (E2E message drafts are also local-only until Stage 4c.) Centralizing scratchpad drafts is a **separate design**, not a quick fix: the local `draft_xxx` scratchpad id has no server row until promotion, so it needs either eager server-side stream creation or a synced scratchpad-metadata entity reconciled on promote. Revisit if the roam promise should cover unsent scratchpads.
- **No retention/expiry policy** beyond resolve-on-send and explicit delete in v1.
- **No "local-only / not-yet-synced" badge.** v1 ships no such indicator. It is a deferred post-Stage-4 idea, recorded here only so the eventual design isn't re-derived — it is **not** a v1 acceptance criterion and nothing in Stages 1–4 implements or tests it. _If_ it is built later: a neutral `local` chip (label "Saved on this device — not yet synced", not an error — the queue retries silently, so an unsynced draft may be offline, server-erroring, or not-yet-drained, and we don't classify which) shown when a draft has never reached the server (`!baseVersion`) and has been idle ~30s (`Date.now() − clientUpdatedAt`), so actively-edited drafts never flash it; the 30s reveal needs a small timer hook since Dexie reactivity is event-driven, the chip must not cause layout shift (INV-21), and it is only meaningful after Stage 4 makes E2E drafts sync (until then encrypted drafts are deliberately local-only and would all read as "failed").
- **No composer focus-retention fix for the style bar / composer controls.** Deferred follow-up, recorded here so it isn't lost — **not** a v1 acceptance criterion and untouched by Stages 1–4. On mobile, tapping an interactable control in the formatting/style bar (bold, italic, etc.) or other composer buttons steals focus from the contenteditable, which dismisses the soft keyboard and makes the composer jump — very annoying to use on a phone. _If_ it is built later: the editor stays focused if the buttons never take focus in the first place — guard each control's `onPointerDown`/`onMouseDown` with `e.preventDefault()` (don't rely on `onClick`, which fires after focus has already moved), so the tap toggles the mark without blurring the editor and the keyboard stays up. Sweep every button rendered alongside the composer (style bar, attach, send, emoji, slash/command triggers), apply the guard consistently (INV-43 — one shared path for the shared behavior), and verify on a real touch device that the keyboard no longer collapses on tap.

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

**Scope:** Close the loop on the message lifecycle and encrypted streams. Shipped
as three independently mergeable PRs (the three workstreams are independent and
E2E is the largest/riskiest), not one combined PR.

#### Stage 4a — Resolve-on-send (frontend wiring) — DONE

The backend resolve endpoint, service, CAS repo method, and tests already landed
in Stage 1 (`POST /drafts/:id/resolve`, `softDeleteCas`, `DraftsService.resolve`).
4a is the frontend wiring that calls it:

- `api/drafts.ts`: `resolve(workspaceId, id, { expectedVersion })`.
- `db/database.ts`: `PendingOperation.type` += `resolve_draft`.
- `sync/draft-sync.ts`: `enqueueDraftResolve` (coalesced CAS resolve op),
  `syncDraftResolution` (confirmed → resolve, never-synced → cancel push),
  `executeDraftResolve` (queue replay), `DraftsServiceLike.resolve`.
- `sync/operation-queue.ts`: `resolve_draft` case (silent retry, break when no service).
- `hooks/use-draft-message.ts`: shared `removeLoadedDraftLocally`; `resolveLoadedDraft`
  (CAS) alongside `clearLoadedDraft` (unconditional discard); `resolveDraft` callback.
- `hooks/use-draft-composer.ts`: expose `resolveDraft`.
- Send/schedule/command sites (`message-input.tsx`, `thread/stream-panel.tsx`):
  call `resolveDraft` (CAS, drifted copy survives) instead of `clearDraft`. Stash
  move + empty-composer discard keep `clearDraft` (unconditional).
- `pages/workspace-layout.tsx`: wire `draftsApi.resolve` into `draftsService`.

**Verification:** `bun run test` (frontend unit/integration — resolve enqueue/execute,
CAS-vs-cancel by baseVersion, send uses resolve not clear). Backend resolve tests
from Stage 1 still green.

#### Stage 4b — Thread re-pointing

- `moveMessagesToThread` (`event-service.ts`): re-scope user's `thread:{targetMessageId}` drafts → `stream:{threadStreamId}` (+ `root_stream_id`) in the move transaction, emit `draft:upserted`. Frontend handler moves the local draft + loaded pointer. Fold the unpromoted-draft-stream case into the existing `promoteDraft` flow (re-scope + push on promotion).

#### Stage 4c — E2E — DONE (body only)

- E2E: seal draft to stream SSK before persist/push; store ciphertext locally; decrypt on load.

The backend (table + `upsertSchema` + repo/service/view) already carried the
`ciphertext` / `envelope` / `e2eVersion` triple from Stage 1, so 4c was
frontend-only:

- `lib/crypto/seal-draft.ts` (new): `sealDraftContent` (reuses `sealOutgoingMessage`,
  the draft id binds the AAD in the message-id slot) and `decryptDraftContent`
  (reuses `tryDecryptMessagePayload`; the AAD travels in the envelope, so no draft
  id needed on open).
- `hooks/use-draft-message.ts`: the old "encrypted streams disable persistence"
  gate is replaced. The hook now reads the viewer id (`useCurrentWorkspaceUserId`,
  extracted to its own hook) + `useE2eSession`, and the third arg is `e2eStreamId`
  (the encrypted root to seal against) instead of a boolean. **Unlocked** → seal on
  save (`upsertLoadedSealedDraft` writes ciphertext + an EMPTY_DOC placeholder, never
  plaintext) and decrypt-on-load into the composer (gated by `isLoaded` until the
  decrypt resolves). **Locked** → behaves exactly as before (nothing loads/persists;
  the sealed row waits on disk). Mount sweep is `purgePlaintextScopeDrafts` (keeps
  sealed rows, removes only plaintext-at-rest).
- `sync/draft-sync.ts`: `cachedDraftFromWire` maps the triple; `applyDraftUpserted`
  no longer drops E2E rows; `executeDraftUpsert` pushes the ciphertext triple (null
  `contentJson`) for sealed rows.
- Call sites (`message-input.tsx`, `thread/stream-panel.tsx`) pass the encrypted
  root (`rootStreamId ?? id`); `use-draft-composer.ts` threads `e2eStreamId`.

**Scope boundary (v1 / 4c cut) — attachments addressed in 4d (below):**

- **E2E-draft attachments / context refs / slash commands were not sealed in 4c** —
  only the body roamed; they stayed session-local. Stage 4d (below) seals
  attachments. Context refs / slash commands remain session-local (their own
  design — they have no message-payload field to ride in).

**Shipped beyond the initial cut, so the feature is usable end-to-end:**

- **Manual stash (Cmd+S) works for encrypted streams.** Stash/restore are pointer
  moves (`stashLoadedDraft` / `restoreStashedDraftToComposer`), not plaintext
  snapshots: the sealed row is detached/attached via the `composerLoaded` pointer,
  so nothing plaintext leaves memory (E2EE-4) and the pile behaves the same for
  plaintext and E2E. `flushDraft` only persists a non-empty editor, so a restore
  fired mid-hydration can't delete the loaded draft.
- **The `/drafts` explorer lists E2E drafts** with decrypt-on-read previews
  (`useDecryptedDraftPreviews` over the shared cache): a ciphertext row counts as
  content, and its body decrypts in memory, falling back to an `Encrypted draft` /
  `Decrypting…` label while locked or mid-decrypt. Rows whose encrypted root can't
  be resolved yet are simply not queued for decrypt (no stuck spinner).
- **Unlock-after-open loads in place.** A draft that decrypts only after the
  session unlocks — or a stash-restore pointer swap — re-hydrates the already-open
  composer via a late-hydrate effect (no stream reopen required), guarded by
  `userEngagedRef` so it never clobbers typed content.

#### Stage 4d — E2E draft attachment sealing — DONE

E2E draft attachments now roam. Reuses the message attachment-seal path end to
end (INV-35), so there is **no backend / types / wire / migration change** — the
attachment linkage rides _inside_ the body's SSK ciphertext, and the wire
`attachmentIds` stays `[]` for E2E (the server holds opaque bytes only).

- `lib/crypto/seal-draft.ts`: `sealDraftContent` carries `attachmentIds` into
  `sealOutgoingMessage`, which seals each file's `attachmentRef`
  (key/iv/filename/mime/size) into the payload exactly as a message does; the
  refs are returned so the write path can seed the decrypt cache.
- `lib/drafts/decryption.ts`: `DraftDecryption` surfaces `attachments` (a
  plaintext draft's own, or a sealed draft's refs mapped to display metadata).
  On decrypt, `requestDraftDecryption` re-registers the recovered refs via
  `rememberAttachmentRef` — on a fresh device the per-file keys were minted on
  the authoring device, so without this a roamed draft could neither view nor
  re-seal its attachments on send. `cachedDraftBody` / `cachedDraftAttachments`
  expose the in-memory plaintext authority the write path re-seals from.
- `hooks/use-draft-message.ts`: the seal write path carries the attachment set
  (kept `[]` at rest, E2EE-4 — the real filename is sealed, never on disk);
  `saveDraft` / `addAttachment` / `removeAttachment` E2E branches re-seal
  body+attachments together, reading the current body + attachments back from the
  decrypt cache so a keystroke or an attachment change preserves the other.
  Returned `attachments` come from the decrypt read (empty while locked/decrypting).
- `hooks/use-draft-composer.ts`: attachments late-hydrate alongside the body on
  the unlock-after-open path (they decrypt together).

**Scope boundary (4d):** context refs / slash commands on E2E drafts remain
session-local — they have no field in the message sealed-payload schema to ride
in, so sealing them would mean extending the shared `@threa/crypto` payload (and
the enclave) for a draft-only concept; deferred as its own design.

**Reuse:** `sealOutgoingMessage` + `serializeSealedPayload` attachment-ref path;
`rememberAttachmentRef` / `getAttachmentRef` in-memory ref cache; the shared
decrypt-cache + draft decrypt core from 4c.

**Verification:** `seal-draft.test.ts` (attachment refs seal + recover on
decrypt); `draft-e2e-roam.test.ts` (attachments survive the wire and their keys
re-register on the receiving device); `use-draft-message.test.ts` (seal carries
attachmentIds, never at rest; add/remove re-seal; content-only save preserves
them; locked is a no-op); `use-decrypted-draft-content.test.ts` (attachments
surfaced from refs). `bun run test`.

**Reuse (4c):** `sealOutgoingMessage` E2E path; existing `promoteDraft` / `setParentThreadId`; resolve CAS from Stage 1.

**Verification:** Backend test: resolve declines on drift, deletes on match; thread-conversion re-points drafts. Frontend/E2E (`test:e2e`): send clears draft; drifted draft survives send; reply draft follows a message into its new thread; E2E draft round-trips without plaintext at rest. `bun run test` + `bun run test:e2e`.

#### Stage 4e — E2E draft context refs + slash-command routing — PROPOSED

4d closed attachments. Two pieces of composer state still stay session-local on
E2E drafts, and this stage seals both into the same SSK ciphertext so they roam.

**What's actually missing (verified against the code, not assumed):**

- **Context refs are a true gap.** `seedDraftWithContextRef`
  (`lib/context-bag/seed-draft.ts`) is the _only_ producer of a draft's
  `contextRefs` sidecar — every other reference is a pass-through read — and it's
  called only by `useDiscussWithAriadne`, which mints a `companionMode: "on"`
  scratchpad. Those scratchpads can be E2E, so a "Discuss with Ariadne" chip
  genuinely lands on an E2E draft today. The seal branch in
  `use-draft-message.ts` writes neither `contextRefs` at rest nor into the
  ciphertext, so the chip vanishes when the draft roams.
- **Slash commands are _mostly_ already covered — the gap is one field.** The
  `slashCommand` node serializes to `/${name}` (`packages/prosemirror/markdown.ts`
  `serializeNode`) and re-parses to a `slashCommand` node on decrypt
  (`parseInline`, the `/[\w-]+` match), so 4d's body seal already roams the
  _visible_ command. What the markdown round-trip drops is `clientActionId` — the
  opaque routing discriminator. A roamed `/discuss-with-ariadne` decrypts to a
  node with `name` but `clientActionId: null`, and `message-input.tsx` routes on
  `clientActionId === DISCUSS_WITH_ARIADNE_COMMAND`, so the recovered draft
  misroutes to server dispatch (`queueCommand`) instead of the local
  `startDiscussWithAriadne`. The frontend never writes the backend `command`
  draft column — commands live only as the node in `contentJson` — so this is the
  whole of the slash-command work: recover `clientActionId` across the seal.

**Design — markdown body + structured sidecars (the 4d pattern, extended).**
Markdown is the lossy external boundary: it carries `/name` but not
`clientActionId`, and has no representation for a context ref at all. The
established shape (INV-35, INV-58) is to seal the markdown body for the
human-readable content and ride everything markdown can't represent losslessly as
**structured sidecars inside the same SSK ciphertext** — exactly how
`attachmentRefs` already work. Context refs and the command join `attachmentRefs`
as sidecars; nothing new lands on the wire or at rest.

**`@threa/crypto` payload change (`sealed-payload.ts`).** Extend `E2eSealedPayload`
/ `ParsedSealedPayload` with one optional **draft-scoped** namespace:

```ts
draft?: {
  contextRefs?: SealedDraftContextRef[]
  command?: SealedDraftCommand
}
```

- **Why namespaced under `draft`, not two new top-level fields:** context refs and
  the command are draft-only — they never appear in a message or an agent reply,
  and the enclave reader must never confuse them with content. A single `draft`
  key signals "ignore unless you are the authoring composer," keeps the
  message/enclave mental model clean (the enclave keeps destructuring only
  `{ contentMarkdown, attachmentRefs }` and is forward-compatible by ignoring
  the field), and groups the two adjuncts that always travel together.
- `SealedDraftContextRef` mirrors `DraftContextRef` structurally (the crypto
  package stays dependency-free — the same mirror-and-bridge discipline as
  `SealedSourceItem` ↔ `SourceItem`). **Only the durable identity fields ride
  sealed** — `refKind`, `streamId`, `fromMessageId`, `toMessageId`,
  `originMessageId`. The transient resolution fields (`status`, `fingerprint`,
  `errorMessage`) are device-local / re-derivable and are NOT sealed: the
  receiving device re-resolves against the shared server bag, so the recovered
  ref reconstructs `status: "ready"` (the bag is server-side and shared; a roamed
  device resolves it the same way the authoring device did) with the other
  transient fields null.
- `SealedDraftCommand = { name: string; clientActionId: string | null }` —
  structural twin of `@threa/types`' `DraftCommand` / `commands.ts`'
  `ExtractedCommand`.
- `isSealedDraftContextRef` / `isSealedDraftCommand` validators mirror
  `isAttachmentRef` — drop malformed elements (decrypted ≠ trusted). No
  `E2E_PAYLOAD_VERSION` bump: the discrimination is structural and additive (old
  payloads simply lack `draft`), exactly as `sources?` was added — old
  drafts/messages decrypt unchanged with an empty `draft`.
- **Serializer signature (decision):** `serializeSealedPayload` is
  `(contentMarkdown, attachmentRefs?, sources?)` today; a 4th optional positional
  pushes it to four. **Recommended:** refactor the extras into an options bag —
  `serializeSealedPayload(contentMarkdown, extras?: { attachmentRefs?; sources?; draft? })`
  — touching the ~4 call sites (`message-envelope.ts`, enclave `run-turn.ts`,
  `trace-observer.ts`); it's mechanical, additive, well-tested, and the named
  shape stops the positional sprawl (INV-12 spirit). **Fallback** (smaller blast
  radius, keeps the enclave/message paths byte-untouched): append `draft?` as a
  4th positional and have only the draft seal path pass it.

**Frontend wiring (no backend / types / wire / migration change).**

- `seal-draft.ts` `sealDraftContent`: accept `contextRefs: DraftContextRef[]` and
  `command: { name; clientActionId } | null`; map context refs to their identity
  fields and forward both into the serialize path. `SealedDraftFields` gains
  `contextRefs` + `command` (the recovered plaintext, to seed the decrypt cache,
  same contract as `attachmentRefs`).
- `decryption.ts`: `DraftDecryption` gains `contextRefs: DraftContextRef[]`.
  `resolveDraftDecryption` maps the decrypted `draft.contextRefs` →
  `DraftContextRef[]` (status reconstructed). Context refs carry **no secret
  material**, so — unlike attachment keys — they need no `rememberAttachmentRef`
  re-registration on a fresh device. New `cachedDraftContextRefs(draftId)` mirrors
  `cachedDraftBody` / `cachedDraftAttachments` as the in-memory plaintext authority
  the write path re-seals from. **Command recovery (decision):** on decrypt,
  re-inject `clientActionId` onto the hydrated `slashCommand` node in `contentJson`
  (a small content walk) so `extractCommandNode` at send recovers it and the node
  stays the single source of truth — preferred over surfacing a separate decrypted
  command the send path must consult.
- `use-draft-message.ts` seal branches (`upsertLoadedDraft` seal branch +
  `saveDraft` / `addAttachment` / `removeAttachment` re-seal): read current context
  refs from `cachedDraftContextRefs` (so a keystroke or attachment change preserves
  them, exactly as 4d does for attachments) and extract the command from
  `contentJson` via `extractCommandNode` at seal time. Keep the at-rest row's
  `contextRefs` undefined (E2EE-4 — never plaintext at rest); seed the decrypt
  cache with the sealed refs + command.
- `use-draft-composer.ts`: extend the 4d late-hydrate effect (unlock-after-open) to
  carry context refs alongside body + attachments, so a sealed discuss-with-ariadne
  draft's `<ContextRefStrip>` chip re-appears on unlock. The command rides inside
  `contentJson`, so it hydrates with the body once `clientActionId` is re-injected
  on decrypt.
- **Wire/sync: unchanged.** `executeDraftUpsert` (`draft-sync.ts`) already forces
  `attachmentIds: []` for E2E and sends `contextRefs: row.contextRefs ?? null`; an
  E2E row's at-rest `contextRefs` stays undefined → wire `null`, while the sealed
  copy rides inside the ciphertext. The plaintext path is untouched. The backend
  `command` / `context_refs` columns stay for the plaintext path and are simply
  null for E2E.

**Scope boundary (4e):** only the producers that exist today — discuss-with-ariadne
context refs and the `/discuss-with-ariadne` `clientActionId`. No speculative
support for future context-ref kinds (INV-36): the seal carries the whole
`DraftContextRef` identity, so new kinds ride free. `status` / `fingerprint` /
`errorMessage` are deliberately not sealed (transient, re-resolved). Command
dispatch is unchanged — only `clientActionId` recovery across roam is added.

**Reuse:** `serializeSealedPayload` / `parseSealedPayload` attachment-ref + sources
pattern (validators, structural-mirror discipline); the 4c/4d decrypt-cache + draft
decrypt core; `extractCommandNode`; the 4d late-hydrate effect.

**Verification:** `sealed-payload.test.ts` (round-trip `draft.contextRefs` +
`draft.command`; malformed elements dropped; pre-4e payloads parse with empty
`draft`; message/enclave destructuring unaffected). `seal-draft.test.ts` (seal
carries context refs + command; full `toEqual` recovery on decrypt, INV-24).
`draft-e2e-roam.test.ts` (a discuss-with-ariadne E2E draft's context ref survives
the wire and re-renders; `/discuss-with-ariadne` recovers `clientActionId` on the
receiving device and routes locally). `use-draft-message.test.ts` (seal carries
context refs/command, never at rest; content-only save and add/remove attachment
preserve them; locked is a no-op). `use-decrypted-draft-content.test.ts` (context
refs surfaced from the decrypted payload). `bun run test` + `bun run test:e2e`.

**Invariant notes (4e):** INV-35 (reuse the seal/parse/decrypt path), INV-36 (no
speculative ref kinds), INV-58 (markdown body + structured sidecars), INV-24
(full-object asserts), E2EE-4 (context refs / command undefined at rest, sealed
only).

## Invariant Notes

- INV-1/2/3/8/50: drafts are workspace- + user-scoped, prefixed-ULID, no FKs/enums.
- INV-20: writes are race-safe via `version` CAS; split-on-conflict is the documented resolution, never select-then-overwrite.
- INV-4/6/7: backend mutations + outbox in one transaction; services own transactions.
- INV-51/52: colocated `drafts` feature, barrel-exported.
- INV-53: socket subscription paired with bootstrap, invalidated on reconnect.
- INV-58: `contentJson` is canonical internally; markdown only at the API boundary.
- E2EE-4: no plaintext draft at rest; E2E drafts persist ciphertext only.
- Not in `TIMELINE_BROADCAST_EVENT_TYPES`: draft events are user-private, not timeline rows.
