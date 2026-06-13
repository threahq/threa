import { db, generateLocalDraftId, type CachedDraft, type PendingOperation } from "@/db"
import type { DraftContextRef } from "@/lib/context-bag/types"
import {
  deleteDraftFromCache,
  hasSeededDraftCache,
  setComposerLoadedInCache,
  upsertDraftInCache,
} from "@/stores/draft-store"
import type {
  Draft,
  DraftDeletedPayload,
  DraftUpsertedPayload,
  JSONContent,
  UpsertDraftInput,
  UpsertDraftResponse,
} from "@threa/types"

/**
 * Stage 3 draft sync — wires the local-first draft store (Stage 2) to the
 * backend `drafts` feature (Stage 1) through the offline operation queue and the
 * author's `user:{userId}` socket room.
 *
 * The cardinal rule is the same on both sides of the wire: **local wins, and on
 * drift we split** — never overwrite, never lose. Duplicated drafts are
 * acceptable; lost drafts are not. The server splits on a `version` mismatch
 * (keeps the existing row, mints a new id for the incoming content); this module
 * mirrors that rule client-side when an incoming socket row collides with edits
 * this device has not yet pushed.
 *
 * "Has unpushed local edits" is read from the operation queue itself — a pending
 * `upsert_draft` op for an id IS the local dirty bit — rather than a flag on the
 * row, so the two can never drift apart.
 *
 * E2E drafts (null `contentJson`, ciphertext-only) are out of scope here: Stage
 * 3 never pushes them (the composer hook gates encrypted streams), and inbound
 * E2E rows are ignored until decrypt-on-load lands in Stage 4.
 */

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

/** Minimal surface of the drafts REST client the queue replays against. */
export interface DraftsServiceLike {
  upsert: (workspaceId: string, id: string, input: UpsertDraftInput) => Promise<UpsertDraftResponse>
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
    contentJson: draft.contentJson ?? EMPTY_DOC,
    attachments: [],
    contextRefs,
    attachmentIds: draft.attachmentIds,
    baseVersion: draft.version,
    clientUpdatedAt: Number.isNaN(clientUpdatedAt) ? Date.now() : clientUpdatedAt,
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
 * rather than dangling a pointer at a missing row).
 */
export async function deleteLocalDraft(workspaceId: string, id: string): Promise<void> {
  let clearedScope: string | null = null
  await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    const row = await db.drafts.get(id)
    if (!row) return
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
  if (hasSeededDraftCache(workspaceId)) {
    deleteDraftFromCache(workspaceId, fromId)
    upsertDraftInCache(workspaceId, toRow)
    if (repointedScope) setComposerLoadedInCache(workspaceId, repointedScope, toRow.id)
  }
}

/**
 * Local split: keep our edits under a fresh id (`ourRow`) and accept the server
 * row under the original id (`serverRow`), repointing the composer to follow our
 * edits. Both rows are written before any delete (atomic, like the id-swap).
 */
async function splitLocalDraft(
  workspaceId: string,
  args: { originalId: string; ourRow: CachedDraft; serverRow: CachedDraft }
): Promise<void> {
  const { originalId, ourRow, serverRow } = args
  let repointedScope: string | null = null
  await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    await db.drafts.put(ourRow)
    await db.drafts.put(serverRow)
    const loaded = await db.composerLoaded.get(serverRow.scope)
    if (loaded?.draftId === originalId) {
      await db.composerLoaded.put({ ...loaded, draftId: ourRow.id })
      repointedScope = serverRow.scope
    }
  })
  if (hasSeededDraftCache(workspaceId)) {
    upsertDraftInCache(workspaceId, ourRow)
    upsertDraftInCache(workspaceId, serverRow)
    if (repointedScope) setComposerLoadedInCache(workspaceId, repointedScope, ourRow.id)
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

async function pendingDraftOps(type: "upsert_draft" | "delete_draft", draftId: string): Promise<PendingOperation[]> {
  const ops = await db.pendingOperations.where("type").equals(type).toArray()
  return ops.filter((op) => op.payload.draftId === draftId)
}

/** True when a draft has edits queued for push but not yet confirmed by the server. */
export async function hasPendingDraftUpsert(draftId: string): Promise<boolean> {
  return (await pendingDraftOps("upsert_draft", draftId)).length > 0
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

/** Drop any queued push for a draft (e.g. an unsynced draft was discarded). */
export async function cancelPendingDraftUpsert(draftId: string): Promise<void> {
  const dupes = await pendingDraftOps("upsert_draft", draftId)
  if (dupes.length > 0) await db.pendingOperations.bulkDelete(dupes.map((op) => op.id))
}

// ============================================================================
// Inbound apply — socket events + bootstrap reconcile
// ============================================================================

/**
 * Apply an inbound `draft:upserted` (another device's edit, or an echo of our
 * own confirmed write) with client-side drift detection:
 *
 *  - No local row → accept the server row.
 *  - `version <= baseVersion` → stale echo (usually our own write returning);
 *    ignore.
 *  - Newer server version, no unpushed local edits → accept (preserving our
 *    local attachment metadata, which the wire row lacks).
 *  - Newer server version AND unpushed local edits → SPLIT: move our edits to a
 *    fresh id (re-routing the queued push) and accept the server row under the
 *    original id.
 */
export async function applyDraftUpserted(payload: DraftUpsertedPayload, expectedWorkspaceId: string): Promise<void> {
  const { draft } = payload
  if (draft.workspaceId !== expectedWorkspaceId) return
  // E2E rows carry no plaintext to render/store yet (Stage 4).
  if (draft.contentJson === null) return

  const local = await db.drafts.get(draft.id)
  if (!local) {
    await putLocalDraft(cachedDraftFromWire(draft))
    return
  }

  if (draft.version <= (local.baseVersion ?? 0)) return

  const dirty = await hasPendingDraftUpsert(draft.id)
  if (!dirty) {
    // Confirmed newer version of a draft we are not editing — accept it, keeping
    // any local attachment metadata (an echo of our own push matches it).
    await putLocalDraft({ ...cachedDraftFromWire(draft), attachments: local.attachments })
    return
  }

  // Drift — our edits collide with a newer server row from another device.
  const ourRow: CachedDraft = { ...local, id: generateLocalDraftId(), baseVersion: 0 }
  const serverRow = cachedDraftFromWire(draft)
  await splitLocalDraft(draft.workspaceId, { originalId: draft.id, ourRow, serverRow })
  await cancelPendingDraftUpsert(draft.id)
  await enqueueDraftUpsert(draft.workspaceId, ourRow.id)
}

/** Apply an inbound `draft:deleted` (a draft discarded/resolved on another device). */
export async function applyDraftDeleted(payload: DraftDeletedPayload, expectedWorkspaceId: string): Promise<void> {
  if (payload.workspaceId !== expectedWorkspaceId) return
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
  for (const draft of drafts) {
    await applyDraftUpserted({ workspaceId: draft.workspaceId, targetUserId: draft.userId, draft }, workspaceId)
  }

  const localDrafts = await db.drafts.where("workspaceId").equals(workspaceId).toArray()
  for (const local of localDrafts) {
    if (serverIds.has(local.id)) continue
    const confirmed = (local.baseVersion ?? 0) > 0
    const queued = await hasPendingDraftUpsert(local.id)
    if (confirmed) {
      // Tombstoned on another device — drop it, unless we have unpushed edits
      // (those re-upsert and split server-side rather than vanish).
      if (!queued) await deleteLocalDraft(workspaceId, local.id)
    } else if (!queued) {
      // Never synced (incl. pre-Stage-3 rows) — mirror it up.
      await enqueueDraftUpsert(workspaceId, local.id)
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
  const input: UpsertDraftInput = {
    scope: row.scope,
    // root_stream_id is populated with thread re-pointing (Stage 4); drafts are
    // private + listed by owner regardless, so null is correct until then.
    rootStreamId: null,
    expectedVersion: row.baseVersion ?? 0,
    writeId: writeIdValue,
    clientUpdatedAt: new Date(row.clientUpdatedAt).toISOString(),
    contentJson: row.contentJson,
    attachmentIds,
    contextRefs: (row.contextRefs as unknown as Record<string, unknown>[] | undefined) ?? null,
  }

  const res = await service.upsert(workspaceId, draftId, input)

  if (res.split) {
    // The server kept the existing row (the other device's content) under
    // `draftId` and minted `res.draft.id` for ours — migrate our local id to it.
    // The original id's divergent server row arrives via its own socket event.
    const current = await db.drafts.get(draftId)
    if (!current) return
    await migrateLocalDraftId(workspaceId, draftId, {
      ...current,
      id: res.draft.id,
      baseVersion: res.draft.version,
    })
    return
  }

  // Happy path — confirm our row at the returned version without clobbering any
  // content typed since the push (only the version basis advances).
  const current = await db.drafts.get(draftId)
  if (!current) return
  await putLocalDraft({ ...current, baseVersion: res.draft.version })
}

/** Push a draft deletion to the backend (operation-queue replay of `delete_draft`). */
export async function executeDraftDelete(
  workspaceId: string,
  draftId: string,
  service: DraftsServiceLike
): Promise<void> {
  await service.delete(workspaceId, draftId)
}
