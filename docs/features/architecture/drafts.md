---
title: Drafts
status: shipped
audience: internal
kind: subsystem
invariants: [INV-20, INV-4, INV-7, INV-53, INV-56, INV-58]
entry_points:
  - apps/backend/src/features/drafts/service.ts
  - apps/backend/src/db/migrations/20260613130739_drafts.sql
  - apps/frontend/src/sync/draft-sync.ts
  - apps/frontend/src/hooks/use-draft-message.ts
  - apps/frontend/src/sync/draft-resolution-guard.ts
public_site: false
summary: >
  A draft is a first-class row that mirrors from the device to the backend and
  roams across the author's devices, with concurrency resolved by local-wins,
  split-on-drift rather than overwrite.
related:
  [
    architecture/sync-engine.md,
    architecture/outbox-pattern.md,
    concepts/race-safe-writes.md,
    concepts/optimistic-then-reconcile.md,
    public/e2e-encrypted-scratchpads.md,
  ]
---

## The gist

A draft is one first-class row per composer payload: the in-progress message for a
single scope (a stream, or a not-yet-threaded parent message). The composer writes it to
IndexedDB first so it never blocks on the network, then mirrors it to a backend `drafts`
table, so the draft roams to the author's other devices over the same `user:{userId}`
socket room that carries their private events. A reply you start on your phone shows up
in the same composer on your laptop.

The whole design turns on one rule: **local wins, and on a conflict we split, never
overwrite.** Two devices editing the same draft is the dangerous case. The naive fix
(last write wins) silently destroys the edit that lost. Instead, when an incoming write
is based on a version the server has already moved past, the server keeps the existing
row untouched and inserts a _fresh_ draft for the incoming content. You end up with two
drafts instead of one. That is deliberate: **duplicated drafts are acceptable; lost
drafts are not.** Everything below is in service of that rule holding under reconnects,
lost acks, sends, and offline edits.

Concurrency rides on an integer `version` with compare-and-swap, the same primitive
`scheduled_messages` uses (INV-20). Delivery rides on the outbox (INV-4/7) into the
author-scoped socket room, and the client reconciles a fresh snapshot on every
reconnect (INV-53). The feature reuses those three proven subsystems and adds only the
split behavior on top.

If you only need the mental model, you can stop here.

## How it works

### The row

`drafts` (`apps/backend/src/db/migrations/20260613130739_drafts.sql`) is workspace- and
user-scoped, with a `draft_`-prefixed ULID id (INV-2), no foreign keys (INV-1), and
`scope` as validated `TEXT` (INV-3). A draft is private to its author: every read and
write filters by `(workspace_id, user_id)`.

`scope` is where the draft is being composed, built from shared helpers so both sides
produce the identical string (INV-33): `draftStreamScope(streamId)` gives
`stream:{streamId}`, `draftThreadScope(parentMessageId)` gives `thread:{messageId}`
for a reply against a not-yet-threaded message.

Content takes one of two shapes. A plaintext draft carries `content_json` and a derived
`content_markdown`. An E2E draft carries the `ciphertext` / `envelope` / `e2e_version`
triple with the plaintext columns null, sealed to the stream key before it ever leaves
the device (E2EE-4, "no plaintext at rest"). `deleted_at` is a soft-delete tombstone so
a removal on one device propagates to the others, and `last_client_write_id` is a
per-push idempotency key (see below).

### The split-on-drift upsert

The one endpoint that matters is `PUT /drafts/:id`, served by `DraftsService.upsert`
(`apps/backend/src/features/drafts/service.ts:87`). It runs in a single transaction and
locks the row by id so concurrent pushes serialize:

1. `insertIfAbsent` (`ON CONFLICT (id) DO NOTHING`). A brand-new id lands at version 1.
   Done.
2. Otherwise lock the existing row. If its `last_client_write_id` equals the incoming
   `writeId`, this is a lost-ack retry of a write the server already accepted, so it
   returns the row unchanged (no spurious split).
3. Otherwise compare-and-swap on `expectedVersion`. A match bumps the version and
   updates in place: the happy path.
4. Otherwise (the version drifted, or the original id is a resolved tombstone) it
   **splits**: the existing row is left untouched and the incoming content is inserted
   under a freshly minted `draft_` id at version 1. The response carries
   `{ split: true, originalId }` so the client migrates its local state to the new id.

Every state-changing branch writes a `draft:upserted` outbox row in the same transaction
(INV-4/7), targeted at the owner's user id. There is no 409 and no merge UI: drift always
resolves to two rows.

### Push and pull on the client

Local writes never block on the network. `useDraftMessage`
(`apps/frontend/src/hooks/use-draft-message.ts`) writes the draft to IndexedDB and the
in-memory draft-store cache immediately, then enqueues an `upsert_draft` operation on the
offline queue. The queue drains serially under a Web Lock, retries silently with backoff,
and never surfaces a failure to the user.

Two ideas make the push safe:

- **The dirty bit is a queued op, not a row flag.** A draft has unpushed edits exactly
  when a pending `upsert_draft` op exists for its id (`hasPendingDraftUpsert`). Read live
  from the op table, it cannot drift out of sync with reality the way a stored flag could.
- **Content is read fresh at drain, and ops coalesce to one per id.** `executeDraftUpsert`
  (`apps/frontend/src/sync/draft-sync.ts:548`) re-reads the draft when the op runs and
  pushes `expectedVersion = baseVersion` (the last server-confirmed version). On a clean
  ack it advances only `baseVersion`, never clobbering content typed since the push; on
  `split: true` it migrates the local id to the server-minted one. Because the queue is
  single-flighted, a user's own rapid sequential edits confirm in order and never
  self-split.

Inbound events arrive on the `user:{userId}` room and go through `applyDraftUpserted`
(`draft-sync.ts:395`), which mirrors the server's rule client-side. No local row means
accept. A version at or below `baseVersion` is a stale echo (usually our own confirmed
write returning), so ignore it. A newer version with no pending push is a clean accept.
A newer version _with_ a pending push is the collision case: this device's edits move to
a fresh id with a re-routed push, the server row keeps the original id, and the composer
follows our edits. `applyDraftDeleted` removes the row unless this device has unpushed
edits, in which case it preserves them under a new id rather than losing them.

### Bootstrap on every reconnect

`SyncEngine.syncDrafts` calls `GET /drafts` and feeds the snapshot through
`applyDraftsBootstrap` (`draft-sync.ts:491`) on every connect and reconnect (INV-53).
Each server draft goes through the same drift-aware apply. Locally-confirmed drafts
absent from the snapshot were resolved or deleted elsewhere and are dropped, _unless_
they still carry unpushed edits. Never-confirmed local drafts (including any authored
before sync existed) are queued for their first push. The whole pass is idempotent, so
re-running it on reconnect is always safe.

That is the core. The rest is reference for when you are working on the edges.

## Details worth knowing

### Resolve-on-send is a separate, CAS-guarded path

Sending a message clears its draft, but a send is not a discard. If another device
edited the draft after this send started, an unconditional delete would destroy that
work. So the send path calls `resolve`, not `delete`:
`POST /drafts/:id/resolve` soft-deletes **only if** `version` still matches
`expectedVersion` (`DraftsService.resolve`, `service.ts:169`). On drift the server keeps
the row and reports `resolved: false`, and the drifted copy survives as a stash entry.
Explicit discard (stashing away, emptying the composer, deleting from the Drafts view)
keeps the unconditional `delete`, which is idempotent on an already-gone row.

### The resolution guard stops a sent draft from coming back

A just-sent draft has two ways to resurrect: a debounced local `saveDraft` can fire in
the window where the resolve teardown is still running and re-create the row into the
composer, and an inbound echo or reconnect bootstrap can re-seed the not-yet-tombstoned
server row. `draft-resolution-guard.ts` is a short-lived (60s), in-memory guard keyed
two ways to close both. `markScopeResolved(scope)` runs as the first statement of
resolve, before the async teardown, so the create branch of `upsertLoadedDraft` refuses a
just-resolved scope regardless of how Dexie interleaves the reads. `markDraftResolved(id,
version)` lets inbound apply drop an echo at or below the resolved version, while a
strictly newer version still applies as a real edit from another device (no loss). The
guard lifts the instant the user re-engages (a keystroke or an attachment), so the next
message starts a fresh draft.

Because the guard is in-memory, it does not survive a page reload. PR #993 made the
suppression durable by reading the queued `resolve_draft` ops directly
(`pendingDraftResolveVersion`): a bootstrap after reload drops rows at or below the
version still queued for resolve, so a sent draft cannot bootstrap back as a stash entry
across a reconnect.

### Thread re-pointing: drafts follow their message

When messages are moved onto a target message, that message becomes a thread and the
scope `thread:{targetMessageId}` stops rendering anywhere. `moveMessagesToThread`
(`apps/backend/src/features/messaging/event-service.ts`) re-scopes those reply drafts to
`stream:{newThreadStreamId}` in the same transaction as the move, via
`DraftsRepository.rescopeByScope`: one set-based UPDATE (INV-56) matched by
`(workspace_id, scope)` with no `user_id` filter, because a shared thread target can hold
reply drafts from several authors and each must follow the message. It bumps `version`
(so a clean client adopts the new scope, a dirty client splits) and emits one
`draft:upserted` per owner. Scratchpad promotion is the mirror case the client owns: the
stream does not exist server-side until promotion creates it, so `promoteDraft` re-scopes
the surviving drafts locally and pushes them, instead of the old behavior that purged
(and lost) the stash siblings.

### E2E drafts roam sealed

For an encrypted stream, the body and attachment references are sealed to the stream SSK
_before_ anything touches disk or the wire, reusing the message seal path
(`sealOutgoingMessage` / `tryDecryptMessagePayload`) with the draft id binding the AAD
(INV-35). The row stores only ciphertext (`contentJson: EMPTY_DOC`, `attachments: []`);
the real body and filenames live only in the in-memory decrypt cache, recovered when the
composer opens the draft and the session is unlocked. The body is sealed as the lossless
`contentJson`, not markdown (INV-58), so attributes markdown cannot represent (for
example a slash command's `clientActionId`) survive the roam. The backend was E2E-ready
from the first migration, so all of this is frontend-only: the wire `attachmentIds` stays
`[]` for E2E and the server holds opaque bytes. See
[e2e-encrypted-scratchpads](../public/e2e-encrypted-scratchpads.md) and the frontend
decrypt-layer notes in `apps/frontend/CLAUDE.md`.

### Why drafts slot into sync for free

`draft:upserted` / `draft:deleted` are user-scoped outbox events. `resolveDeliveryGroups`
already routes user-scoped events to `user:{userId}`, and the sync-log catch-up already
admits `user:{userId}` entries on reconnect, so live delivery and catch-up both worked
with no change to the sync feature. Drafts are deliberately **not** in
`TIMELINE_BROADCAST_EVENT_TYPES`: they are private, not timeline rows, so the
contiguity / `broadcastSequence` machinery (INV-61) correctly does not apply to them.

## Boundaries

- **Unpromoted scratchpad drafts are local-only.** The roaming store backs channel, DM,
  and thread _message_ drafts. A draft inside a not-yet-created scratchpad lives in a
  separate local store with no version or sync fields and never leaves the device until
  `promoteDraft` creates the real stream. Because scratchpads are the solo-first primary
  entry point, they are the bulk of a typical `/drafts` view, so the Drafts page _reads_
  as local-only even though message drafts genuinely roam. Centralizing scratchpad drafts
  is a separate design (it needs either eager server-side stream creation or a synced
  scratchpad-metadata entity), not a quick follow-up.
- **The composer-loaded pointer never syncs.** Which draft is checked out into the
  composer is device-local state. A fresh device opens the composer empty; only a
  migrated or explicitly-set pointer restores content. Inbound sync never activates the
  composer, so a roamed draft can only land in the stash, never pop into the editor.
- **No conflict UI and no "from another device" badge.** A split draft just appears as
  another stash entry, with nothing marking its origin or marking a not-yet-synced draft
  as local-only. There is no merge surface; the model is duplicate-then-let-the-user-pick.
- **E2E context refs and slash commands do not roam.** Only the E2E draft body and
  attachment references are sealed. Context refs (the discuss-with-ariadne chips) and
  slash-command nodes on encrypted drafts stay session-local, because no current flow
  lands a context ref on an E2E draft and neither has a field in the shared sealed-payload
  schema to ride in (INV-36).
- **Tombstones are not garbage-collected.** `deleted_at` rows accumulate; retention is
  post-v1.
- **No `_syncStatus` field.** The dirty state is derived from the op queue, not stored on
  the row, so nothing renders a per-draft "saving / saved" indicator.

## Invariants

- **INV-20**: the upsert and resolve never select-then-update; concurrency is
  integer-version compare-and-swap inside a row lock.
- **INV-4 / INV-7**: `draft:upserted` / `draft:deleted` are written to the outbox in the
  same transaction as the row mutation, never published ad hoc.
- **INV-53**: every (re)connect pulls `GET /drafts` and reconciles the snapshot, so a
  socket gap cannot silently drop a draft.
- **INV-56**: thread re-pointing is one set-based UPDATE across all owners' drafts, not a
  per-row loop.
- **INV-58**: `contentJson` is the canonical body, including the E2E seal; markdown is
  derived only at the backend boundary.

## Entry points

- `apps/backend/src/db/migrations/20260613130739_drafts.sql`: the `drafts` table and its
  two partial indexes.
- `apps/backend/src/features/drafts/service.ts`: split-on-drift `upsert`, CAS `resolve`,
  unconditional `delete`, bootstrap `list`; outbox-in-transaction.
- `apps/backend/src/features/drafts/repository.ts`: `insertIfAbsent` / `casUpdate` /
  `softDeleteCas` / `rescopeByScope` / `listByUser`.
- `apps/frontend/src/sync/draft-sync.ts`: wire-to-local mapping, the coalesced
  silent-retry queue helpers, drift-aware inbound apply, bootstrap reconcile, outbound
  push.
- `apps/frontend/src/hooks/use-draft-message.ts`: the composer's write path, including
  the E2E seal-on-save and resolve-vs-discard split.
- `apps/frontend/src/sync/draft-resolution-guard.ts`: the post-send resurrection guard.
- `apps/frontend/src/lib/crypto/seal-draft.ts`: seal/open a draft body and attachments
  on the message E2E path.
