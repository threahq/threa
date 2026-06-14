import { db, generateLocalDraftId, type CachedDraft, type PendingOperation } from "@/db"
import type { DraftContextRef } from "@/lib/context-bag/types"
import {
  deleteDraftFromCache,
  hasSeededDraftCache,
  migrateDraftScopeInCache,
  migrateLoadedDraftInCache,
  setComposerLoadedInCache,
  upsertDraftInCache,
} from "@/stores/draft-store"
import type {
  Draft,
  DraftDeletedPayload,
  DraftUpsertedPayload,
  JSONContent,
  ResolveDraftInput,
  ResolveDraftResponse,
  UpsertDraftInput,
  UpsertDraftResponse,
} from "@threa/types"

/**
 * Stage 3 draft sync — wires the local-first draft store (Stage 2) to the
 * backend `drafts` feature (Stage 1) through the offline operation queue and the
 * author's `user:{userId}` socket room.
 *
 * The cardinal rule is **local wins, and on drift we split** — never overwrite,
 * never lose. Duplicated drafts are acceptable; lost drafts are not. The split is
 * resolved in exactly one place: the **server**, which on a `version` mismatch
 * keeps the existing row and mints a new id for the incoming content
 * (`executeDraftUpsert` then migrates our local id). Inbound socket rows are
 * never split client-side — doing so would fork this device's own in-flight
 * write, whose echo can arrive before the push's ack records `baseVersion`. So
 * while we hold unpushed edits we simply ignore inbound rows and let our queued
 * push reach the authoritative server.
 *
 * "Has unpushed local edits" is read from the operation queue itself — a pending
 * `upsert_draft` op for an id IS the local dirty bit — rather than a flag on the
 * row, so the two can never drift apart.
 *
 * E2E drafts roam as ciphertext (Stage 4c): the composer seals the body before
 * it is persisted and pushed, so this layer carries the `ciphertext` / `envelope`
 * / `e2eVersion` triple (with null `contentJson`) over the wire and stores it
 * sealed at rest — the plaintext is decrypted into memory only when the composer
 * loads the draft. The drift/split bookkeeping below is content-shape-agnostic.
 */

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

/** Minimal surface of the drafts REST client the queue replays against. */
export interface DraftsServiceLike {
  upsert: (workspaceId: string, id: string, input: UpsertDraftInput) => Promise<UpsertDraftResponse>
  resolve: (workspaceId: string, id: string, input: ResolveDraftInput) => Promise<ResolveDraftResponse>
  delete: (workspaceId: string, id: string) => Promise<void>
}

// ============================================================================
// Wire ↔ local mapping
// ============================================================================

/**
 * Project a wire `Draft` into the local `CachedDraft` shape. The wire row
 * carries only attachment ids, not the `DraftAttachment` display metadata, so
 * `attachments` is left empty here — callers that already hold local metadata
 * for this id (an accepted echo of our own draft) merge it back in. `version`
 * becomes `baseVersion`: the confirmed basis for the next push.
 */
export function cachedDraftFromWire(draft: Draft): CachedDraft {
  const contextRefs =
    draft.contextRefs && draft.contextRefs.length > 0 ? (draft.contextRefs as unknown as DraftContextRef[]) : undefined
  const clientUpdatedAt = Date.parse(draft.clientUpdatedAt)
  return {
    id: draft.id,
    workspaceId: draft.workspaceId,
    scope: draft.scope,
    // E2E rows carry null `contentJson` on the wire (the body lives sealed in
    // `ciphertext`); the placeholder keeps the local shape uniform and the
    // composer decrypts the body into memory on load.
    contentJson: draft.contentJson ?? EMPTY_DOC,
    attachments: [],
    contextRefs,
    attachmentIds: draft.attachmentIds,
    baseVersion: draft.version,
    clientUpdatedAt: Number.isNaN(clientUpdatedAt) ? Date.now() : clientUpdatedAt,
    ...(draft.ciphertext != null
      ? { ciphertext: draft.ciphertext, envelope: draft.envelope, e2eVersion: draft.e2eVersion ?? undefined }
      : {}),
  }
}

// ============================================================================
// Local persistence primitives (IDB + in-memory draft-store cache)
// ============================================================================

/** Write a draft to IDB and (when the workspace cache is live) the store cache. */
export async function putLocalDraft(row: CachedDraft): Promise<void> {
  await db.drafts.put(row)
  if (hasSeededDraftCache(row.workspaceId)) upsertDraftInCache(row.workspaceId, row)
}

/**
 * Delete a draft locally, clearing the composer-loaded pointer when it referred
 * to this id (so a remote delete of the checked-out draft empties the composer
 * rather than dangling a pointer at a missing row). Returns the removed row (or
 * `undefined` if it was already gone) so a user-initiated delete can mirror the
 * removal to the backend off its `baseVersion`; the inbound-apply callers ignore
 * the return. Local only — does NOT touch the server (that's `deleteDraftById`).
 */
export async function deleteLocalDraft(workspaceId: string, id: string): Promise<CachedDraft | undefined> {
  let clearedScope: string | null = null
  let removed: CachedDraft | undefined
  await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    const row = await db.drafts.get(id)
    if (!row) return
    removed = row
    const loaded = await db.composerLoaded.get(row.scope)
    if (loaded?.draftId === id) {
      await db.composerLoaded.delete(row.scope)
      clearedScope = row.scope
    }
    await db.drafts.delete(id)
  })
  if (hasSeededDraftCache(workspaceId)) {
    deleteDraftFromCache(workspaceId, id)
    if (clearedScope) setComposerLoadedInCache(workspaceId, clearedScope, null)
  }
  return removed
}

/**
 * Delete a draft by id AND mirror the removal to the backend — the single
 * user-initiated draft-delete path. A draft is a draft: whether it was the one
 * loaded into a composer or a stash sibling, deletion is identical, so the
 * in-composer stash list and the Drafts explorer both call this rather than
 * branching on loaded-vs-stashed. Removes the local row (clearing the loaded
 * pointer when it pointed here) and queues an unconditional, idempotent server
 * delete so the removal propagates to the author's other devices. No-op on an
 * already-gone row. Callers kick the operation queue so the delete drains now.
 */
export async function deleteDraftById(workspaceId: string, id: string): Promise<void> {
  const removed = await deleteLocalDraft(workspaceId, id)
  if (removed) await syncDraftRemoval(workspaceId, id, removed.baseVersion)
}

/**
 * Re-scope a draft in place (same id, `fromScope` → `toRow.scope`) when the
 * server moves it — thread re-pointing (`moveMessagesToThread`) and draft-stream
 * promotion. If the draft was the one checked out into the composer under
 * `fromScope`, its device-local `composerLoaded` pointer moves with it so the
 * reply being composed follows the message into its new thread instead of being
 * stranded under a scope nothing renders. The row write and the pointer move
 * share one transaction (and one cache signal) so a live reader never sees the
 * draft loaded under both scopes or under neither.
 */
export async function migrateLocalDraftScope(
  workspaceId: string,
  fromScope: string,
  toRow: CachedDraft
): Promise<void> {
  let movedToScope: string | null = null
  await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    await db.drafts.put(toRow)
    const loaded = await db.composerLoaded.get(fromScope)
    if (loaded?.draftId === toRow.id) {
      await db.composerLoaded.delete(fromScope)
      await db.composerLoaded.put({ scope: toRow.scope, workspaceId, draftId: toRow.id })
      movedToScope = toRow.scope
    }
  })
  if (hasSeededDraftCache(workspaceId)) {
    migrateDraftScopeInCache(workspaceId, fromScope, toRow, movedToScope)
  }
}

/**
 * Atomically re-key a draft from `fromId` to `toRow.id`, repointing the
 * composer-loaded pointer if it referenced the old id. Mirrors the
 * optimistic-message id-swap in `stream-sync.ts`: the new row is written before
 * the old one is removed, so a live Dexie query never observes a frame with
 * neither present.
 */
export async function migrateLocalDraftId(workspaceId: string, fromId: string, toRow: CachedDraft): Promise<void> {
  let repointedScope: string | null = null
  await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    await db.drafts.put(toRow)
    const loaded = await db.composerLoaded.get(toRow.scope)
    if (loaded?.draftId === fromId) {
      await db.composerLoaded.put({ ...loaded, draftId: toRow.id })
      repointedScope = toRow.scope
    }
    await db.drafts.delete(fromId)
  })
  // One cache signal (delete-old + insert-new + repoint) so a reader never sees
  // the loaded draft missing mid-migration — i.e. the composer never flashes
  // empty during a server split or a remote-delete preserve.
  if (hasSeededDraftCache(workspaceId)) {
    migrateLoadedDraftInCache(workspaceId, fromId, toRow, repointedScope)
  }
}

// ============================================================================
// Operation-queue helpers (the queue is the source of truth for "dirty")
// ============================================================================

function operationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function writeId(): string {
  return `write_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

async function pendingDraftOps(
  type: "upsert_draft" | "resolve_draft" | "delete_draft",
  draftId: string
): Promise<PendingOperation[]> {
  const ops = await db.pendingOperations.where("type").equals(type).toArray()
  return ops.filter((op) => op.payload.draftId === draftId)
}

/** True when a draft has edits queued for push but not yet confirmed by the server. */
export async function hasPendingDraftUpsert(draftId: string): Promise<boolean> {
  return (await pendingDraftOps("upsert_draft", draftId)).length > 0
}

/**
 * True when a draft has a server delete queued but not yet drained. The local
 * row is already gone (delete-then-enqueue), so an inbound upsert for this id is
 * a stale view of a draft the user discarded — accepting it would resurrect the
 * row until the delete op drains. The queued delete is authoritative.
 */
export async function hasPendingDraftDelete(draftId: string): Promise<boolean> {
  return (await pendingDraftOps("delete_draft", draftId)).length > 0
}

/**
 * Enqueue a debounced background push for a draft. Coalesces to at most one
 * queued `upsert_draft` op per id: the op reads the draft's current content
 * fresh at drain time, so a superseded op would only re-push identical state.
 * A fresh `writeId` (per-push idempotency key, reused across that op's retries)
 * means a lost ack never causes a spurious server-side split.
 */
export async function enqueueDraftUpsert(workspaceId: string, draftId: string): Promise<void> {
  await db.transaction("rw", db.pendingOperations, async () => {
    const dupes = await pendingDraftOps("upsert_draft", draftId)
    if (dupes.length > 0) await db.pendingOperations.bulkDelete(dupes.map((op) => op.id))
    await db.pendingOperations.add({
      id: operationId(),
      workspaceId,
      type: "upsert_draft",
      payload: { draftId, writeId: writeId() },
      createdAt: Date.now(),
      retryCount: 0,
    })
  })
}

/**
 * Enqueue an unconditional server delete for a draft and drop any queued push
 * for it (no point mirroring content we're discarding). Use only when the draft
 * may exist server-side (`baseVersion > 0`); for a never-synced draft call
 * `cancelPendingDraftUpsert` instead — there is nothing to delete.
 */
export async function enqueueDraftDelete(workspaceId: string, draftId: string): Promise<void> {
  await db.transaction("rw", db.pendingOperations, async () => {
    const stale = [
      ...(await pendingDraftOps("upsert_draft", draftId)),
      ...(await pendingDraftOps("delete_draft", draftId)),
    ]
    if (stale.length > 0) await db.pendingOperations.bulkDelete(stale.map((op) => op.id))
    await db.pendingOperations.add({
      id: operationId(),
      workspaceId,
      type: "delete_draft",
      payload: { draftId },
      createdAt: Date.now(),
      retryCount: 0,
    })
  })
}

/**
 * Enqueue a CAS clear-on-send for a draft (resolve-on-send) and drop any queued
 * push or delete for it. `expectedVersion` is the last server-confirmed version
 * (`baseVersion`); the server removes the row only if it still matches, so a
 * copy that drifted on another device survives as a stash entry. Use only when
 * the draft reached the server (`baseVersion > 0`); for a never-synced draft
 * call `cancelPendingDraftUpsert` — there is nothing on the server to resolve.
 */
export async function enqueueDraftResolve(
  workspaceId: string,
  draftId: string,
  expectedVersion: number
): Promise<void> {
  await db.transaction("rw", db.pendingOperations, async () => {
    const stale = [
      ...(await pendingDraftOps("upsert_draft", draftId)),
      ...(await pendingDraftOps("resolve_draft", draftId)),
      ...(await pendingDraftOps("delete_draft", draftId)),
    ]
    if (stale.length > 0) await db.pendingOperations.bulkDelete(stale.map((op) => op.id))
    await db.pendingOperations.add({
      id: operationId(),
      workspaceId,
      type: "resolve_draft",
      payload: { draftId, expectedVersion },
      createdAt: Date.now(),
      retryCount: 0,
    })
  })
}

/** Drop any queued push for a draft (e.g. an unsynced draft was discarded). */
export async function cancelPendingDraftUpsert(draftId: string): Promise<void> {
  const dupes = await pendingDraftOps("upsert_draft", draftId)
  if (dupes.length > 0) await db.pendingOperations.bulkDelete(dupes.map((op) => op.id))
}

/**
 * Mirror a locally-removed draft to the backend: a confirmed draft
 * (`baseVersion > 0`) has a server row to delete; a never-synced one only needs
 * its queued push dropped (nothing exists server-side). Shared by every local
 * delete path (composer clear, scope purge, stash discard).
 */
export async function syncDraftRemoval(
  workspaceId: string,
  id: string,
  baseVersion: number | undefined
): Promise<void> {
  if ((baseVersion ?? 0) > 0) {
    await enqueueDraftDelete(workspaceId, id)
  } else {
    await cancelPendingDraftUpsert(id)
  }
}

/**
 * Mirror a sent draft's removal to the backend CAS-safely (resolve-on-send): a
 * confirmed draft (`baseVersion > 0`) is resolved on the version it was last
 * confirmed at, so a copy that drifted on another device survives as a stash
 * entry; a never-synced one only needs its queued push dropped (nothing exists
 * server-side). The counterpart to `syncDraftRemoval` for the send path — the
 * local row is already gone by the time this runs.
 */
export async function syncDraftResolution(
  workspaceId: string,
  id: string,
  baseVersion: number | undefined
): Promise<void> {
  if ((baseVersion ?? 0) > 0) {
    await enqueueDraftResolve(workspaceId, id, baseVersion as number)
  } else {
    await cancelPendingDraftUpsert(id)
  }
}

// ============================================================================
// Inbound apply — socket events + bootstrap reconcile
// ============================================================================

/**
 * Apply an inbound `draft:upserted` (another device's edit, or an echo of our
 * own confirmed write):
 *
 *  - No local row → accept the server row.
 *  - `version <= baseVersion` → stale echo (usually our own write returning);
 *    ignore.
 *  - Newer server version, unpushed local edits exist → IGNORE. The server is
 *    the single authority on drift: our queued push will reach it and it splits
 *    CAS-safely (executeDraftUpsert then migrates our local id). Resolving the
 *    drift here too would fork our OWN in-flight write — its echo can arrive
 *    before the push's HTTP ack records `baseVersion`, and a local split would
 *    then mint a duplicate of the draft we are editing.
 *  - Newer server version, no unpushed edits → accept (preserving local
 *    attachment metadata the wire row lacks). When the scope also changed
 *    (thread re-pointing — the target message became a thread), the draft moves
 *    to the new scope and its loaded pointer follows so the reply isn't stranded.
 */
export async function applyDraftUpserted(
  payload: DraftUpsertedPayload,
  expectedWorkspaceId: string,
  pendingUpsertIds?: ReadonlySet<string>,
  pendingDeleteIds?: ReadonlySet<string>
): Promise<void> {
  const { draft } = payload
  if (draft.workspaceId !== expectedWorkspaceId) return

  // A queued local delete wins: the user discarded this draft here and its
  // `delete_draft` op (not yet drained) will remove the server row. Until then,
  // accepting an echo or a bootstrap re-seed would resurrect the row the user
  // deleted — so the delete would appear not to "stick". (The set, passed by
  // bootstrap, avoids a per-draft op-table scan.)
  const deleting = pendingDeleteIds ? pendingDeleteIds.has(draft.id) : await hasPendingDraftDelete(draft.id)
  if (deleting) return

  const local = await db.drafts.get(draft.id)
  if (!local) {
    await putLocalDraft(cachedDraftFromWire(draft))
    return
  }

  if (draft.version <= (local.baseVersion ?? 0)) return

  // Unpushed local edits → leave them; the pending push lets the server arbitrate
  // (the pending set, passed by bootstrap, avoids a per-draft op-table scan).
  const dirty = pendingUpsertIds ? pendingUpsertIds.has(draft.id) : await hasPendingDraftUpsert(draft.id)
  if (dirty) return

  // Clean locally — accept the server row, keeping any local attachment metadata
  // (an echo of our own confirmed push matches it). A changed scope (thread
  // re-pointing) takes the scope-move path so the loaded pointer follows the
  // draft to its new scope; same-scope edits are a plain put.
  const accepted = { ...cachedDraftFromWire(draft), attachments: local.attachments }
  if (local.scope !== draft.scope) {
    await migrateLocalDraftScope(expectedWorkspaceId, local.scope, accepted)
  } else {
    await putLocalDraft(accepted)
  }
}

/**
 * Apply an inbound `draft:deleted` (a draft discarded/resolved on another
 * device). If this device has unpushed edits on that id, the remote delete must
 * not destroy them (cardinal no-loss rule): preserve them under a fresh id that
 * re-syncs — the same split shape as inbound-upsert drift — instead of deleting.
 * Otherwise drop the row and clear its pointer.
 */
export async function applyDraftDeleted(payload: DraftDeletedPayload, expectedWorkspaceId: string): Promise<void> {
  if (payload.workspaceId !== expectedWorkspaceId) return

  if (await hasPendingDraftUpsert(payload.draftId)) {
    const current = await db.drafts.get(payload.draftId)
    if (current) {
      const replacementId = generateLocalDraftId()
      await cancelPendingDraftUpsert(payload.draftId)
      await migrateLocalDraftId(payload.workspaceId, payload.draftId, {
        ...current,
        id: replacementId,
        baseVersion: 0,
      })
      await enqueueDraftUpsert(payload.workspaceId, replacementId)
      return
    }
  }

  await cancelPendingDraftUpsert(payload.draftId)
  await deleteLocalDraft(payload.workspaceId, payload.draftId)
}

/**
 * Reconcile the server snapshot from `GET /drafts` against the local store
 * (INV-53 bootstrap apply). Each server draft goes through the drift-aware
 * apply above; then locally-confirmed drafts absent from the snapshot are
 * dropped (they were resolved/deleted elsewhere), while never-confirmed local
 * drafts — including drafts authored before Stage 3 ever pushed — are kept and
 * queued for their first push. Drafts with edits already in the queue are left
 * for the queue to push. The caller kicks the queue after this resolves.
 */
export async function applyDraftsBootstrap(workspaceId: string, drafts: Draft[]): Promise<void> {
  const serverIds = new Set(drafts.map((d) => d.id))
  // Read the queued `upsert_draft` / `delete_draft` ids once (indexed, in
  // parallel) and reuse the sets across the loops, rather than scanning the op
  // table per draft. A queued delete means the user discarded that draft here;
  // the re-seed must not resurrect it before the delete drains.
  const [upsertOps, deleteOps] = await Promise.all([
    db.pendingOperations.where("type").equals("upsert_draft").toArray(),
    db.pendingOperations.where("type").equals("delete_draft").toArray(),
  ])
  const pendingUpsertIds = new Set(upsertOps.map((op) => op.payload.draftId as string))
  const pendingDeleteIds = new Set(deleteOps.map((op) => op.payload.draftId as string))
  for (const draft of drafts) {
    await applyDraftUpserted(
      { workspaceId: draft.workspaceId, targetUserId: draft.userId, draft },
      workspaceId,
      pendingUpsertIds,
      pendingDeleteIds
    )
  }

  const localDrafts = await db.drafts.where("workspaceId").equals(workspaceId).toArray()
  for (const local of localDrafts) {
    if (serverIds.has(local.id)) continue
    const confirmed = (local.baseVersion ?? 0) > 0
    const queued = pendingUpsertIds.has(local.id)
    if (confirmed) {
      // Tombstoned on another device — drop it, unless we have unpushed edits
      // (those re-upsert and split server-side rather than vanish).
      if (!queued) await deleteLocalDraft(workspaceId, local.id)
    } else if (!queued) {
      // Never synced (incl. pre-Stage-3 rows) — mirror it up.
      await enqueueDraftUpsert(workspaceId, local.id)
      pendingUpsertIds.add(local.id)
    }
  }
}

// ============================================================================
// Outbound push — executed by the operation queue
// ============================================================================

/**
 * Push a draft's current local state to the backend (operation-queue replay of
 * `upsert_draft`). Reads the draft fresh so a coalesced op always mirrors the
 * latest content, and pushes `expectedVersion = baseVersion`. Throws on failure
 * so the queue retries with backoff — never surfaced to the user.
 */
export async function executeDraftUpsert(
  workspaceId: string,
  draftId: string,
  writeIdValue: string,
  service: DraftsServiceLike
): Promise<void> {
  const row = await db.drafts.get(draftId)
  if (!row) return // discarded locally after the op was enqueued — nothing to push

  const attachmentIds = row.attachments.length > 0 ? row.attachments.map((a) => a.id) : (row.attachmentIds ?? [])
  const isE2e = row.ciphertext != null
  const input: UpsertDraftInput = {
    scope: row.scope,
    // The server owns root_stream_id on thread re-pointing (it sets it when a
    // re-scoped draft follows its message into a thread); the client never needs
    // to send it — drafts are private + listed by owner regardless of scope.
    rootStreamId: null,
    expectedVersion: row.baseVersion ?? 0,
    writeId: writeIdValue,
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    // An E2E draft pushes its sealed body, never plaintext — the server stores
    // the ciphertext opaquely and the upsert schema rejects carrying both.
    contentJson: isE2e ? null : row.contentJson,
    attachmentIds,
    contextRefs: (row.contextRefs as unknown as Record<string, unknown>[] | undefined) ?? null,
    ciphertext: isE2e ? row.ciphertext : null,
    envelope: isE2e ? row.envelope : null,
    e2eVersion: isE2e ? (row.e2eVersion ?? null) : null,
  }

  const res = await service.upsert(workspaceId, draftId, input)

  if (res.split) {
    // The server kept the existing row (the other device's content) under
    // `draftId` and minted `res.draft.id` for ours — migrate our local id to it.
    // The original id's divergent server row arrives via its own socket event.
    const current = await db.drafts.get(draftId)
    if (!current) {
      // Discarded locally while the push was in flight — the server still minted
      // a fresh row for our (now-gone) content; delete it so it can't resurrect.
      await enqueueDraftDelete(workspaceId, res.draft.id)
      return
    }
    await migrateLocalDraftId(workspaceId, draftId, {
      ...current,
      id: res.draft.id,
      baseVersion: res.draft.version,
    })
    // Re-route the queue to the migrated id: any pending op still targets the old
    // id (now a no-op), and edits typed during the in-flight split push live under
    // the new id — push them so they reach the server instead of stranding locally.
    await cancelPendingDraftUpsert(draftId)
    await enqueueDraftUpsert(workspaceId, res.draft.id)
    return
  }

  // Happy path — confirm our row at the returned version without clobbering any
  // content typed since the push (only the version basis advances). The
  // existence check and the write share one transaction so a concurrent local
  // discard can't slip between them and have us re-create a row the user just
  // deleted; if the row is gone, the server now holds a draft the user threw
  // away, so we delete it (otherwise it resurrects on the next pull — the
  // "ghost draft" race).
  let confirmed: CachedDraft | undefined
  await db.transaction("rw", db.drafts, async () => {
    const current = await db.drafts.get(draftId)
    if (!current) return
    confirmed = { ...current, baseVersion: res.draft.version }
    await db.drafts.put(confirmed)
  })
  if (!confirmed) {
    await enqueueDraftDelete(workspaceId, draftId)
    return
  }
  if (hasSeededDraftCache(workspaceId)) upsertDraftInCache(workspaceId, confirmed)
}

/**
 * Resolve a draft on the backend after its message sent (operation-queue replay
 * of `resolve_draft`). CAS-guarded by `expectedVersion`: the server keeps a
 * drifted copy (`resolved: false`) rather than deleting it, and that copy
 * re-syncs as a stash entry on the next bootstrap. Either outcome is terminal
 * for this op — the local row is already gone — so the response is informational
 * and nothing more runs locally. Throws (network) so the queue retries; resolve
 * is idempotent (a re-run hits an already-tombstoned row and returns
 * `resolved: false`), so no idempotency key is needed.
 */
export async function executeDraftResolve(
  workspaceId: string,
  draftId: string,
  expectedVersion: number,
  service: DraftsServiceLike
): Promise<void> {
  await service.resolve(workspaceId, draftId, { expectedVersion })
}

/** Push a draft deletion to the backend (operation-queue replay of `delete_draft`). */
export async function executeDraftDelete(
  workspaceId: string,
  draftId: string,
  service: DraftsServiceLike
): Promise<void> {
  await service.delete(workspaceId, draftId)
}
