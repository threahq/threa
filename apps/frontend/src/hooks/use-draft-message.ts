import { useCallback, useEffect, useRef } from "react"
import { db, generateLocalDraftId, type CachedDraft, type DraftAttachment } from "@/db"
import type { DraftContextRef } from "@/lib/context-bag/types"
import {
  deleteDraftFromCache,
  hasSeededDraftCache,
  setComposerLoadedInCache,
  upsertDraftInCache,
  upsertLoadedDraftInCache,
  useComposerLoadedFromStore,
  useDraftsFromStore,
} from "@/stores/draft-store"
import { enqueueDraftUpsert, migrateLocalDraftScope, syncDraftRemoval, syncDraftResolution } from "@/sync/draft-sync"
import { clearStagedDraft, readStagedDraft, stageDraftContent } from "@/lib/drafts/draft-staging"
import {
  getScopeResolveSeq,
  markDraftResolved,
  recordScopeResolved,
  resolveMigratedDraftId,
} from "@/sync/draft-resolution-guard"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { type JSONContent, draftStreamScope, draftThreadScope } from "@threa/types"
import { serializeToMarkdown } from "@threa/prosemirror"
import { EMPTY_DOC, isEmptyContent } from "@/lib/prosemirror-utils"
import { useE2eSession } from "@/stores/e2e-session-store"
import { sealDraftContent, type SealedDraftFields } from "@/lib/crypto/seal-draft"
import { invalidateDecryption, seedDecryption } from "@/lib/crypto/decrypt-cache"
import { cachedDraftAttachments, cachedDraftBody } from "@/lib/drafts/decryption"
import { useCurrentWorkspaceUserId } from "./use-current-workspace-user-id"
import { useDecryptedDraftContent } from "./use-decrypted-draft-content"

// Key formats (a draft's `scope`):
// - "stream:{streamId}" for messages in existing streams
// - "thread:{anchorId}" for new threads (reply to a timeline item — message or
//   card — that has no thread stream of its own yet)
export function getDraftMessageKey(
  location: { type: "stream"; streamId: string } | { type: "thread"; anchorId: string }
): string {
  if (location.type === "stream") {
    return draftStreamScope(location.streamId)
  }
  return draftThreadScope(location.anchorId)
}

const DEBOUNCE_MS = import.meta.env.VITE_DRAFT_DEBOUNCE_MS ? Number(import.meta.env.VITE_DRAFT_DEBOUNCE_MS) : 500

function isStaleObservedResolve(scope: string, observedResolveSeq: number | undefined): boolean {
  return observedResolveSeq !== undefined && getScopeResolveSeq(scope) > observedResolveSeq
}

/** Resolve the draft id currently checked out into the composer for a scope. */
async function getLoadedDraftId(scope: string): Promise<string | null> {
  const row = await db.composerLoaded.get(scope)
  return row?.draftId ?? null
}

export interface DraftFields {
  contentJson: JSONContent
  attachments: DraftAttachment[]
  contextRefs?: DraftContextRef[]
}

function sameDraftPayload(row: CachedDraft, fields: DraftFields): boolean {
  const contentJson = row.ciphertext ? cachedDraftBody(row.id) : row.contentJson
  if (!contentJson) return false
  const attachments = row.ciphertext ? cachedDraftAttachments(row.id) : row.attachments
  return (
    JSON.stringify(contentJson) === JSON.stringify(fields.contentJson) &&
    JSON.stringify(attachments) === JSON.stringify(fields.attachments) &&
    JSON.stringify(row.contextRefs ?? []) === JSON.stringify(fields.contextRefs ?? [])
  )
}

/**
 * E2E seal context for a draft write — present only for encrypted streams.
 * `streamId` is the encrypted root whose current SSK seals the body.
 */
export interface DraftSealContext {
  senderId: string
  streamId: string
}

/**
 * Create or update the draft loaded into the composer for `scope`. The single
 * write path for both shapes (INV-35): with no `seal` context the body is stored
 * as plaintext `contentJson`; with one, the body is sealed to the stream SSK and
 * only the `ciphertext`/`envelope`/`e2eVersion` sibling is persisted — IDB never
 * holds the plaintext (E2EE-4, treat IDB like the backend).
 *
 * On the E2E path the shared decrypt cache is invalidated and then re-seeded with
 * the just-authored plaintext, so the read path (`useDecryptedDraftContent`) serves
 * the live body with no self-decrypt round-trip. The invalidate matters because a
 * draft id is stable across edits: `seedDecryption` alone no-ops once an id is
 * decrypted, so without it the SECOND edit would be ignored and a remount would
 * render the first edit's body. The seed is dropped with every other entry on lock.
 *
 * Stage 4d: the seal carries the draft's attachments — their per-file
 * key/iv/filename ride sealed inside `ciphertext` (as `attachmentRefs`), exactly
 * as a message's do, so attachments roam with the body. The plaintext attachment
 * linkage never lands on disk (`attachments` stays `[]` at rest, E2EE-4); the
 * composer reads it back from the seeded/decrypted cache. (Context refs stay
 * session-local — deferred.)
 */
// Overloads: only an identity-addressed save (expectedDraftId set) can be
// dropped for a deleted row — every other call always yields the row.
export async function upsertLoadedDraft(
  workspaceId: string,
  scope: string,
  fields: DraftFields,
  seal?: DraftSealContext,
  opts?: { observedResolveSeq?: number; expectedDraftId?: undefined; createIfMissing?: boolean }
): Promise<CachedDraft>
export async function upsertLoadedDraft(
  workspaceId: string,
  scope: string,
  fields: DraftFields,
  seal?: DraftSealContext,
  opts?: { observedResolveSeq?: number; expectedDraftId?: string | null; createIfMissing?: boolean }
): Promise<CachedDraft | null>
export async function upsertLoadedDraft(
  workspaceId: string,
  scope: string,
  fields: DraftFields,
  seal?: DraftSealContext,
  opts?: {
    /**
     * The scope's resolve sequence observed when this save began. Passed only by
     * the debounced typing save: if a resolve-on-send advanced the sequence while
     * the save was in flight, creating a draft here would resurrect the just-sent
     * content into the composer, so the create is dropped. Other create paths pass
     * nothing and are never affected.
     */
    observedResolveSeq?: number
    /**
     * The draft row this content belongs to — the id the composer's live content
     * hydrated from (or was created as). When set, the save is addressed by ROW
     * identity, not by the scope's `composerLoaded` pointer: a save landing after
     * the pointer was repointed at another draft still writes its own row instead
     * of overwriting the newly-pointed one. The pointer is never written in this
     * branch (a stashed row taking late keystrokes stays stashed). When the row
     * has been deleted underneath, the save falls back to the create path and
     * claims the pointer only if the scope has none.
     */
    expectedDraftId?: string | null
    /**
     * Only a caller that JUST MINTED `expectedDraftId` (the detached-create
     * paths) may create when the row is missing. A named real id that is gone —
     * and not re-keyed — was DELETED; recreating it from a late save would
     * resurrect deleted content, so the save is dropped (null) instead.
     */
    createIfMissing?: boolean
  }
): Promise<CachedDraft | null> {
  // The save's target identity is re-validated INSIDE the write transaction:
  // a split ack can migrate the loaded draft's id (and a push ack can advance
  // its baseVersion) between our reads and our write. Writing against the
  // stale identity would resurrect the pre-split id as a duplicate row — one
  // that re-pushes, re-splits, and breeds copies — so on a mismatch we retry
  // against the new identity instead. Two retries bound the loop; a save that
  // still conflicts is dropped — the content stands in the editor (and, for
  // plaintext scopes, the staging buffer) until the next keystroke re-saves.
  let row!: CachedDraft
  const expectedId = opts?.expectedDraftId ?? null
  // Set when the expected row turned out to be owned by ANOTHER scope's composer
  // and this editor has genuinely different content. An identical late save is
  // only the old surface finishing the same-device hand-off; splitting that
  // creates the duplicate row the move was meant to avoid.
  let forceCreate = false
  let unchangedForeignRow: CachedDraft | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    // Identity-addressed when the caller named a row; pointer-addressed otherwise.
    let loadedId = forceCreate ? null : (expectedId ?? (await getLoadedDraftId(scope)))
    let existing = loadedId ? await db.drafts.get(loadedId) : undefined
    if (expectedId && !existing && !forceCreate) {
      // The expected row may have been RE-KEYED rather than deleted (a split ack
      // or a remote-delete preserve runs `migrateLocalDraftId`). Follow the
      // migration before concluding the row is gone: creating a fresh row here
      // would fork the draft the user is still typing into. Only a genuinely
      // unmigrated missing row falls through to the create path below.
      const migratedId = resolveMigratedDraftId(expectedId)
      const migratedRow = migratedId === expectedId ? undefined : await db.drafts.get(migratedId)
      if (migratedRow) {
        loadedId = migratedId
        existing = migratedRow
      } else if (!opts?.createIfMissing) {
        // Named, gone, and not re-keyed: the row was deleted. Dropping the save
        // is the no-resurrection rule — the delete (local or remote) already
        // handled the composer via the pointer transition.
        return null
      }
    }
    // The draft id binds the seal AAD (in the message-id slot), so resolve it
    // before sealing — a re-seal of the same draft reuses the id.
    const id = existing?.id ?? generateLocalDraftId()

    // The attachment refs the seal embedded — re-seeded into the decrypt cache
    // below so the composer reads attachments back without a self-decrypt.
    let sealedAttachmentRefs: SealedDraftFields["attachmentRefs"] = []
    if (seal) {
      // Seal outside the transaction (async crypto would break a Dexie txn);
      // the AAD binds `id`, which the txn re-validates before persisting.
      const sealed = await sealDraftContent({
        workspaceId,
        senderId: seal.senderId,
        streamId: seal.streamId,
        draftId: id,
        contentJson: fields.contentJson,
        attachmentIds: fields.attachments.map((a) => a.id),
      })
      row = {
        id,
        workspaceId,
        scope,
        // E2EE-4: neither the plaintext body nor the plaintext attachment linkage
        // lands on disk — the sealed `ciphertext` is the at-rest copy of both (the
        // attachment key/iv/filename ride inside it as `attachmentRefs`), and
        // `contentJson`/`attachments` are only empty placeholders. The composer
        // reads body + attachments back from the seeded/decrypted in-memory cache.
        contentJson: EMPTY_DOC,
        attachments: [],
        clientUpdatedAt: Date.now(),
        baseVersion: existing?.baseVersion,
        stashedAt: existing?.stashedAt,
        ciphertext: sealed.ciphertext,
        envelope: sealed.envelope,
        e2eVersion: sealed.e2eVersion,
      }
      sealedAttachmentRefs = sealed.attachmentRefs
    } else {
      const contextRefs = fields.contextRefs && fields.contextRefs.length > 0 ? fields.contextRefs : undefined
      row = {
        id,
        workspaceId,
        scope,
        contentJson: fields.contentJson,
        attachments: fields.attachments,
        contextRefs,
        clientUpdatedAt: Date.now(),
        // Carry the sync bookkeeping forward. Without this, editing a confirmed
        // draft would reset baseVersion to undefined, and the next push
        // (expectedVersion 0) would collide with the server's existing row and the
        // server would SPLIT it into a duplicate — once per keystroke after the
        // first sync. Preserve it so the push CAS-updates in place instead.
        baseVersion: existing?.baseVersion,
        stashedAt: existing?.stashedAt,
        attachmentIds: existing?.attachmentIds,
      }
    }

    // One transaction for the row write, the pointer, AND the queued push: the
    // pending op IS the dirty bit, so committing the row without it opens a
    // window where an inbound echo reads this device as clean and overwrites
    // the just-typed content.
    //
    // The resolve-seq guard runs inside too: if a resolve-on-send advanced the
    // scope's sequence since this (debounced) save began, the save is a stale
    // echo of just-sent content — creating a draft from it would resurrect the
    // sent message into the composer. `recordScopeResolved` runs before the
    // resolve clears the pointer, so by the time the cleared pointer routes a
    // stale save into the create branch the bumped seq is visible.
    let wrotePointer = false
    const outcome = await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
      if (isStaleObservedResolve(scope, opts?.observedResolveSeq)) return "dropped"
      const livePointer = (await db.composerLoaded.get(scope))?.draftId ?? null
      // Pointer-addressed saves revalidate the pointer; identity-addressed ones
      // revalidate the ROW below, so a repoint can't route them onto another draft.
      if (!expectedId && livePointer !== loadedId) return "conflict"
      if (existing) {
        const liveRow = await db.drafts.get(id)
        if (!liveRow) return "conflict"
        // A pointer in ANOTHER scope means a take-over moved this row while the
        // save was in flight. The common mobile hand-off leaves an identical
        // debounce behind; that is already the moved row, not concurrent work,
        // so it is a no-op. Only divergent content earns a split.
        if (expectedId) {
          const holders = await db.composerLoaded.where("workspaceId").equals(workspaceId).toArray()
          if (holders.some((p) => p.draftId === id && p.scope !== scope)) {
            if (sameDraftPayload(liveRow, fields)) {
              unchangedForeignRow = liveRow
              return "unchanged-foreign"
            }
            return "foreign"
          }
        }
        // Freshest sync bookkeeping wins: a push ack can advance baseVersion
        // between our read and this txn, and writing the stale value back would
        // make the next push CAS against an old version and split.
        row = seal
          ? { ...row, baseVersion: liveRow.baseVersion, stashedAt: liveRow.stashedAt }
          : {
              ...row,
              baseVersion: liveRow.baseVersion,
              stashedAt: liveRow.stashedAt,
              attachmentIds: liveRow.attachmentIds,
            }
        await db.drafts.put(row)
      } else {
        await db.drafts.put(row)
        // Claim the pointer only when the scope has none. An identity-addressed
        // save whose row was deleted underneath lands here; stealing a pointer
        // that now references another draft would detach that draft instead.
        if (livePointer === null) {
          await db.composerLoaded.put({ scope, workspaceId, draftId: id })
          wrotePointer = true
        }
      }
      // Mirror to the backend: a coalesced push that retries silently. The
      // caller kicks the queue so it drains promptly.
      await enqueueDraftUpsert(workspaceId, id)
      return "persisted"
    })

    if (outcome === "foreign") {
      forceCreate = true
      continue
    }
    if (outcome === "unchanged-foreign") return unchangedForeignRow!
    if (outcome === "conflict") continue
    if (outcome === "dropped") return row
    if (wrotePointer) {
      upsertLoadedDraftInCache(workspaceId, row, scope)
    } else {
      upsertDraftInCache(workspaceId, row)
    }

    if (seal) {
      // Keep the read path serving the live plaintext: invalidate the reused
      // id's stale entry, then seed the fresh body AND the attachment refs just
      // sealed, so the next decrypt-on-read (and any remount) serves THIS
      // edit's body + attachments, not a prior one. The refs carry the
      // filename/mime/size the composer renders and the key/iv a later send
      // re-seals.
      invalidateDecryption(id)
      seedDecryption(id, {
        contentMarkdown: serializeToMarkdown(fields.contentJson),
        contentJson: fields.contentJson,
        attachmentRefs: sealedAttachmentRefs,
        sources: [],
      })
    }
    return row
  }
  return row
}

/**
 * Remove the loaded draft for `scope` locally (IDB row + pointer + cache) and
 * mirror the removal to the backend via `mirror`. Shared by `clearLoadedDraft`
 * (discard) and `resolveLoadedDraft` (send) — they differ only in how the
 * removal is mirrored, so the local teardown lives on one path (INV-43).
 *
 * The pointer read, the row delete, the pointer clear, AND the mirror enqueue
 * happen in ONE transaction. Reading `baseVersion` inside keeps a mid-clear
 * server confirmation from slipping between read and delete (the "ghost draft"
 * race); the pointer clear inside stops a `draft:upserted` echo landing
 * mid-teardown from re-inserting the just-cleared draft as an orphan stash
 * entry; and the enqueue inside means there is no instant where the row is
 * gone but no queued op yet marks it as deleted/resolved (an echo in that gap
 * would resurrect it).
 */
async function removeLoadedDraftLocally(
  workspaceId: string,
  scope: string,
  mirror: (loadedId: string, baseVersion: number | undefined) => Promise<void>,
  /**
   * When set, the pointer is re-asserted INSIDE the txn to still name this row
   * (INV-20): an identity-addressed empty save read the pointer outside, and a
   * restore repointing the scope in that gap must make the delete a no-op — not
   * destroy whatever the pointer now holds (and mirror the delete everywhere).
   * The pointer-addressed callers ("whatever is loaded") pass nothing.
   */
  expectedDraftId?: string | null
): Promise<void> {
  let removedId: string | null = null
  await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
    const loadedId = (await db.composerLoaded.get(scope))?.draftId ?? null
    if (expectedDraftId && loadedId !== expectedDraftId) return
    let version: number | undefined
    if (loadedId) {
      const row = await db.drafts.get(loadedId)
      version = row?.baseVersion
      await db.drafts.delete(loadedId)
    }
    await db.composerLoaded.delete(scope)
    if (loadedId) await mirror(loadedId, version)
    removedId = loadedId
  })
  if (removedId) deleteDraftFromCache(workspaceId, removedId)
  setComposerLoadedInCache(workspaceId, scope, null)
}

/**
 * Discard the loaded draft for `scope` and clear its pointer (stashes survive).
 * The backend mirror is an UNCONDITIONAL delete — the user threw it away, so
 * drift doesn't matter.
 */
export async function clearLoadedDraft(
  workspaceId: string,
  scope: string,
  /**
   * The row the caller means to discard (see `upsertLoadedDraft`'s
   * `expectedDraftId`). When the scope's pointer has since moved off it — an
   * empty debounced save landing after a repoint — the row is deleted BY ID and
   * the pointer (and the staging buffer, which now belongs to the new draft) is
   * left alone. Omitted by the discard/send paths, which mean "whatever is loaded".
   */
  expectedDraftId?: string | null
): Promise<void> {
  let targetId: string | null = null
  if (expectedDraftId) {
    // Follow a re-key (`migrateLocalDraftId`) so an empty save for the pre-split
    // id clears the row that id became, not nothing at all.
    targetId = (await db.drafts.get(expectedDraftId)) ? expectedDraftId : resolveMigratedDraftId(expectedDraftId)
    const pointer = (await db.composerLoaded.get(scope))?.draftId ?? null
    if (pointer !== targetId) {
      // The delete-path twin of the write path's foreign-holder split, enforced
      // INSIDE `removeDraftRowById`'s transaction (INV-20): a pointer anywhere
      // referencing the row — the calling scope's pointer returning to it, or a
      // take-over having given it to another composer — makes the delete a no-op.
      await removeDraftRowById(workspaceId, targetId, (id, baseVersion) =>
        syncDraftRemoval(workspaceId, id, baseVersion)
      )
      return
    }
  }
  // Drop the staging buffer first (synchronous) so a racing flush or a reload
  // can't recover the discarded content back into the composer.
  clearStagedDraft(workspaceId, scope)
  await removeLoadedDraftLocally(
    workspaceId,
    scope,
    (loadedId, baseVersion) => syncDraftRemoval(workspaceId, loadedId, baseVersion),
    // The RESOLVED id: the in-txn re-assertion must track a re-key the same way
    // the branch above did, or a mid-clear migration turns the guard into a
    // spurious no-op.
    targetId
  )
}

/**
 * Delete draft row `draftId` and mirror the removal, leaving every scope pointer
 * untouched. The identity-addressed counterpart of `removeLoadedDraftLocally`:
 * used when an empty save arrives for a row the scope no longer points at. Same
 * one-transaction shape (read version, delete, enqueue) for the same reasons.
 */
async function removeDraftRowById(
  workspaceId: string,
  draftId: string,
  mirror: (draftId: string, baseVersion: number | undefined) => Promise<void>
): Promise<void> {
  const removed = await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
    const row = await db.drafts.get(draftId)
    if (!row) return false
    // Re-validated INSIDE the txn (INV-20): a pointer ANYWHERE referencing this
    // row means a composer owns it — either the pointer returned to the calling
    // scope in the check-act gap (deleting would leave it dangling and wedge the
    // scope), or a take-over gave the row to another scope's composer (deleting
    // would destroy it out from under them and mirror the delete to every
    // device). Both mean: not ours to delete, do nothing.
    const holders = await db.composerLoaded.where("workspaceId").equals(workspaceId).toArray()
    if (holders.some((p) => p.draftId === draftId)) return false
    await db.drafts.delete(draftId)
    await mirror(draftId, row.baseVersion)
    return true
  })
  if (removed) deleteDraftFromCache(workspaceId, draftId)
}

/**
 * Resolve the loaded draft for `scope` after its message sent: remove it locally
 * (same teardown as a discard), but mirror the removal to the backend as a
 * CAS clear-on-send so a copy that drifted on another device survives as a stash
 * entry instead of being collaterally deleted (plan §resolve-on-send).
 */
export async function resolveLoadedDraft(workspaceId: string, scope: string): Promise<void> {
  // Drop the staging buffer first (synchronous) so the just-sent content can't be
  // recovered by a reload, nor re-staged by a debounced flush racing the teardown
  // — the same resurrection class the resolution guard below closes.
  clearStagedDraft(workspaceId, scope)
  // Bump the scope's resolve sequence BEFORE the async teardown so a debounced
  // save already in flight can't re-create the draft once the pointer is cleared
  // (see the guard in `upsertLoadedDraft`). Ordering matters: this synchronous
  // bump happens-before the pointer delete, which happens-before any later read
  // that would route a racing save into the create path — so the save sees the
  // advanced seq and drops its create.
  recordScopeResolved(scope)
  await removeLoadedDraftLocally(workspaceId, scope, async (loadedId, baseVersion) => {
    // Remember this draft's (id, version) so an inbound echo of our own push, or a
    // reconnect bootstrap that re-seeds the still-present server row before the
    // resolve op drains, is dropped rather than resurrected as a stash entry. A
    // strictly newer version from another device is NOT suppressed (no-loss).
    markDraftResolved(loadedId, baseVersion ?? 0)
    await syncDraftResolution(workspaceId, loadedId, baseVersion)
  })
}

/**
 * Delete every draft for `scope` and clear its pointer. Used by the draft-stream
 * promotion / discard flows to clear a scope entirely.
 */
export async function purgeScopeDrafts(workspaceId: string, scope: string): Promise<void> {
  clearStagedDraft(workspaceId, scope)
  // Read + delete the rows, clear the loaded pointer, AND enqueue the server
  // deletes atomically: `baseVersion` reflects any server confirmation that
  // landed before the delete (ghost-draft race), and an inbound echo can never
  // land in an instant where a row is gone with no queued delete to suppress
  // its resurrection.
  const rows = await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
    const found = await db.drafts.where("[workspaceId+scope]").equals([workspaceId, scope]).toArray()
    for (const row of found) await db.drafts.delete(row.id)
    await db.composerLoaded.delete(scope)
    for (const row of found) await syncDraftRemoval(workspaceId, row.id, row.baseVersion)
    return found
  })
  for (const row of rows) deleteDraftFromCache(workspaceId, row.id)
  setComposerLoadedInCache(workspaceId, scope, null)
}

/**
 * Delete only the PLAINTEXT drafts for an E2E `scope`, keeping sealed rows. Run
 * on mount of an encrypted-stream composer: a plaintext draft written before the
 * stream was encrypted (or in the brief window before the stream row loaded and
 * the composer knew it was E2E) must not stay at rest (E2EE-4), but a sealed
 * draft is the legitimate roaming copy and is preserved. The loaded pointer is
 * cleared only when it referenced a purged plaintext row.
 */
export async function purgePlaintextScopeDrafts(workspaceId: string, scope: string): Promise<void> {
  // E2EE-4 defense in depth: an encrypted scope must never have a plaintext
  // staging buffer. The write path already gates staging on encryption, so this
  // only ever clears a stray entry written before the stream was known to be E2E.
  clearStagedDraft(workspaceId, scope)
  let clearedPointer = false
  const removed = await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
    const found = await db.drafts.where("[workspaceId+scope]").equals([workspaceId, scope]).toArray()
    const plaintext = found.filter((row) => !row.ciphertext)
    const loaded = await db.composerLoaded.get(scope)
    for (const row of plaintext) await db.drafts.delete(row.id)
    if (loaded && plaintext.some((row) => row.id === loaded.draftId)) {
      await db.composerLoaded.delete(scope)
      clearedPointer = true
    }
    // Mirror the removal of any plaintext copy that reached the server, inside
    // the same txn so an echo can't resurrect a row mid-purge.
    for (const row of plaintext) await syncDraftRemoval(workspaceId, row.id, row.baseVersion)
    return plaintext
  })
  for (const row of removed) deleteDraftFromCache(workspaceId, row.id)
  if (clearedPointer) setComposerLoadedInCache(workspaceId, scope, null)
}

/**
 * Stash the draft currently loaded into the composer for `scope`: detach it (clear
 * the device-local loaded pointer) so it becomes a stash entry, WITHOUT copying or
 * re-writing its body. The row stays at rest exactly as it is — plaintext or sealed
 * (E2EE-4) — and keeps roaming; only the "checked out" pointer is cleared. This is
 * the shape-agnostic stash: there is no plaintext snapshot to leak for an E2E draft
 * because the sealed row already holds the body. Returns the detached draft id, or
 * `null` when nothing was loaded. Callers flush the live editor content into the row
 * first (so unsaved keystrokes survive) and reset the editor afterward.
 */
export async function stashLoadedDraft(
  workspaceId: string,
  scope: string,
  /**
   * `putAway: false` is a MECHANICAL detach — a disarm dropping a conversation
   * arm, a relocate displacing the target's loaded draft. The pointer clears but
   * the draft stays fully advertised (board button, auto-restore, fork
   * indicators): the user never said "put it away", so no surface may act as if
   * they did. Only the deliberate stash gesture (Cmd+S / "Save current") writes
   * the durable marker.
   */
  opts?: { putAway?: boolean }
): Promise<string | null> {
  const putAway = opts?.putAway ?? true
  // The caller flushed the live editor into the row before stashing, so the
  // staged buffer is now redundant; drop it so a reload doesn't recover the
  // stashed body back into the (now draft-less) composer as a new loaded draft.
  clearStagedDraft(workspaceId, scope)
  // Stash is a durable, synced statement: `stashedAt` rides the row
  // so no surface on any device advertises or auto-restores it until a restore
  // clears the flag. Marker + pointer detach + push enqueue in one txn, so the
  // stashed row is never visible without its dirty bit. `clientUpdatedAt` is
  // deliberately NOT bumped — putting a draft away must not reorder the pile.
  let stashed: CachedDraft | null = null
  const draftId = await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
    const id = (await db.composerLoaded.get(scope))?.draftId ?? null
    if (!id) return null
    const row = await db.drafts.get(id)
    if (putAway && row && row.stashedAt == null) {
      stashed = { ...row, stashedAt: Date.now() }
      await db.drafts.put(stashed)
      await enqueueDraftUpsert(workspaceId, id)
    }
    await db.composerLoaded.delete(scope)
    return id
  })
  if (!draftId) return null
  if (stashed) upsertDraftInCache(workspaceId, stashed)
  setComposerLoadedInCache(workspaceId, scope, null)
  return draftId
}

/**
 * Restore draft `draftId` into the composer for `scope` by pointing the scope at
 * it — a TAKE-OVER: any other scope's pointer at this draft is detached in the
 * same transaction, so the draft is never live in two composers at once and a
 * visible pile row is always loadable (no "checked out elsewhere" refusal). The
 * detached composers react through the pointer-null path (blank, or split their
 * engaged content into a fresh row — the same protection a cross-device send
 * already exercises). Whatever this scope held becomes a stash entry
 * automatically (a scope points at exactly one draft), so the swap never loses
 * work. The row's body — plaintext or sealed — is untouched; the composer
 * decrypts on read. No snapshot, no server round-trip.
 */
export async function restoreStashedDraftToComposer(
  workspaceId: string,
  scope: string,
  draftId: string
): Promise<boolean> {
  // Drop the staging buffer: it holds the keystrokes for the draft being swapped
  // OUT (already flushed to its own row by the caller), so leaving it would let a
  // reload before the next keystroke recover that stale body over the draft we
  // just restored — corrupting it. The restored draft re-stages on its first edit.
  clearStagedDraft(workspaceId, scope)
  let pointedId = draftId
  let unstashed: CachedDraft | null = null
  const detached = await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
    // The id is re-validated INSIDE the txn (INV-20): a split ack can re-key the
    // row (`migrateLocalDraftId`) between the caller's read and here — the
    // caller's flush is an IDB write sitting in exactly that window — and
    // pointing the scope at a retired id renders an empty composer over an
    // orphaned row. Follow the migration; a genuinely-gone row restores nothing.
    if (!(await db.drafts.get(pointedId))) {
      const migrated = resolveMigratedDraftId(pointedId)
      if (migrated === pointedId || !(await db.drafts.get(migrated))) return null
      pointedId = migrated
    }
    const holders = await db.composerLoaded.where("workspaceId").equals(workspaceId).toArray()
    const others = holders.filter((row) => row.draftId === pointedId && row.scope !== scope)
    for (const row of others) await db.composerLoaded.delete(row.scope)
    await db.composerLoaded.put({ scope, workspaceId, draftId: pointedId })
    // Restoring unstashes: the durable "put away" flag clears the
    // moment a composer takes the draft back, and the clear rides the same push
    // machinery so every device's resting affordances resume advertising it.
    const row = await db.drafts.get(pointedId)
    if (row && row.stashedAt != null) {
      unstashed = { ...row, stashedAt: null }
      await db.drafts.put(unstashed)
      await enqueueDraftUpsert(workspaceId, pointedId)
    }
    return others.map((row) => row.scope)
  })
  if (detached === null) return false
  if (unstashed) upsertDraftInCache(workspaceId, unstashed)
  for (const detachedScope of detached) {
    // Same teardown a stash does for the scope it detaches: the staging buffer's
    // keystrokes belong to the draft just taken, and a reload's reconcile would
    // otherwise "recover" them into a brand-new duplicate row under the old
    // scope (and claim its pointer).
    clearStagedDraft(workspaceId, detachedScope)
    setComposerLoadedInCache(workspaceId, detachedScope, null)
  }
  setComposerLoadedInCache(workspaceId, scope, pointedId)
  return true
}

/**
 * Re-scope every draft for `fromScope` to `toScope` and push each so the server
 * row follows. The client-initiated counterpart to inbound thread re-pointing:
 * used by `promoteDraft` when a not-yet-created scratchpad becomes a real stream,
 * so the drafts composed in it (loaded plus any stash siblings) move onto the
 * real stream and keep roaming instead of being discarded. The loaded pointer
 * follows its draft (via `migrateLocalDraftScope`). No-op when the scope is empty.
 *
 * The just-sent loaded draft is already resolved by the send path before promotion
 * runs, so in practice this carries the surviving stash entries.
 */
export async function rescopeScopeDrafts(workspaceId: string, fromScope: string, toScope: string): Promise<void> {
  const rows = await db.drafts.where("[workspaceId+scope]").equals([workspaceId, fromScope]).toArray()
  for (const row of rows) {
    // Move + enqueue in one txn so the re-scoped row is never visible without
    // its dirty bit (an inbound echo in that gap could overwrite the move). The
    // row is re-read inside the txn — writing the pre-read copy would drop a
    // save that committed in between.
    await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
      const live = await db.drafts.get(row.id)
      if (!live || live.scope !== fromScope) return
      await migrateLocalDraftScope(workspaceId, fromScope, { ...live, scope: toScope })
      // forceNewOp: a push snapshotted before this move may be in flight with its
      // claim not yet visible — coalescing onto it would lose the scope move when
      // it completes (live repro: cancel-armed-reply left the server row branch-
      // scoped forever). The fresh op re-reads the moved row at drain.
      await enqueueDraftUpsert(workspaceId, live.id, { forceNewOp: true })
    })
  }
  // The crash-safe staging buffer (localStorage) must follow the move: a staged
  // entry left under the old scope no longer matches any IDB row there, so the
  // startup reconcile would "recover" it — resurrecting the draft under the
  // scope the user just moved it out of.
  const staged = readStagedDraft(workspaceId, fromScope)
  if (staged) {
    stageDraftContent(workspaceId, toScope, staged.contentJson)
    clearStagedDraft(workspaceId, fromScope)
  }
}

/**
 * Move the loaded draft from `fromScope` to `toScope` without changing its id or
 * payload. The composer flushes first, then this changes only filing metadata:
 * the editor remains the authority for content while the same draft follows it.
 * An existing loaded draft at the destination is merely displaced into that
 * scope's pile; its row is never overwritten.
 *
 * Scope move + pointer move + forced sync op commit atomically. The forced op
 * carries any in-flight write lineage, so an old-scope push that already left
 * the device is followed by an idempotent push of the new scope rather than
 * winning last or splitting this device's draft.
 */
export async function relocateLoadedDraft(
  workspaceId: string,
  fromScope: string,
  toScope: string,
  opts?: { targetHost?: string }
): Promise<CachedDraft | null> {
  let moved: CachedDraft | null = null
  await db.transaction("rw", db.drafts, db.composerLoaded, db.composerTarget, db.pendingOperations, async () => {
    const loadedId = (await db.composerLoaded.get(fromScope))?.draftId ?? null
    const live = loadedId ? await db.drafts.get(loadedId) : null
    if (live && live.scope === fromScope) {
      moved = { ...live, scope: toScope }
      await migrateLocalDraftScope(workspaceId, fromScope, moved)
      await enqueueDraftUpsert(workspaceId, live.id, { forceNewOp: true })
    }
    if (opts?.targetHost) {
      if (toScope === opts.targetHost) await db.composerTarget.delete(opts.targetHost)
      else await db.composerTarget.put({ host: opts.targetHost, workspaceId, scope: toScope })
    }
  })

  const staged = readStagedDraft(workspaceId, fromScope)
  if (staged) {
    stageDraftContent(workspaceId, toScope, staged.contentJson)
    clearStagedDraft(workspaceId, fromScope)
  }
  return moved
}

/**
 * @param e2eStreamId The encrypted stream the draft seals to — the root stream
 *   whose SSK wraps the body (a thread passes its root). Pass it only for E2E
 *   streams; `undefined`/`null` means plaintext. When set and the session is
 *   unlocked, the body is sealed before it touches disk (E2EE-4) and decrypted
 *   on read through the shared decrypt cache (the same path messages use), which
 *   retries on unlock and clears on lock. While the session is locked the read
 *   reports `locked` and the composer shows the encryption notice; the sealed row
 *   waits on disk. Attachments roam sealed inside the body's ciphertext (Stage 4d);
 *   context refs on E2E drafts stay session-local (deferred).
 */
export function useDraftMessage(
  workspaceId: string,
  draftKey: string,
  e2eStreamId?: string | null,
  /**
   * Owned by the composer: the id of the draft row the live editor content
   * hydrated from (or was created as). Every save path here addresses THAT row
   * rather than re-reading the scope's pointer, so a pointer repointed between
   * hydration and a debounced save can't route the write onto another draft.
   * `null` means "no identity yet" and keeps the historical pointer-addressed
   * behaviour (a fresh composer that has not yet read a draft).
   */
  contentDraftIdRef?: { current: string | null }
) {
  const e2eEnabled = !!e2eStreamId
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackContentDraftIdRef = useRef<string | null>(null)
  // Serializes this composer's WRITES (typing saves, attachment edits): under a
  // main-thread stall, two queued debounce timers can fire back-to-back and the
  // second save starts before the first's create resolves — it then reads a
  // null identity against its OWN freshly-claimed pointer, misreads it as
  // foreign, and forks a detached prefix row that survives the send (seen live:
  // a stray "Sho" draft after sending "Should we ship…"). Chained, every save
  // observes its predecessor's identity.
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const chainWrite = useCallback(<T>(run: () => Promise<T>): Promise<T> => {
    const next = writeChainRef.current.then(run, run)
    writeChainRef.current = next.catch(() => undefined)
    return next
  }, [])
  const contentDraftId = contentDraftIdRef ?? fallbackContentDraftIdRef
  // Only a caller that supplied a real identity ref gets the strict
  // null-identity re-route below: for it, "null while the pointer holds a
  // draft" provably means the editor never hydrated that draft. A ref-less
  // caller has no hydration protocol, so null just means "address the pointer"
  // — the historical contract.
  const strictIdentity = contentDraftIdRef !== undefined

  // Seal needs the viewer's workspace user id and unlocked UIK. Read here (not
  // threaded from the call site) so the composer reacts when the session unlocks
  // without a remount.
  const senderId = useCurrentWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, senderId ?? "")
  const e2eUnlocked =
    e2eEnabled && !!senderId && session.status === "unlocked" && !!session.privateKey && !!session.keyId

  const drafts = useDraftsFromStore(workspaceId)
  const loaded = useComposerLoadedFromStore(workspaceId)
  // The loaded row resolves the same whether the stream is plaintext, E2E-locked,
  // or E2E-unlocked — the read path below reports the right status. (A locked E2E
  // draft resolves its row but renders as `locked`, not as content.)
  const loadedId = loaded.find((row) => row.scope === draftKey)?.draftId ?? null
  const resolvedDraft = loadedId ? drafts.find((draft) => draft.id === loadedId) : undefined

  // Decrypt-on-read through the shared cache — same path messages use. Branches
  // on `ciphertext`, holds at `pending` until the root is known + session
  // unlocked, retries on unlock, clears on lock. No bespoke per-hook decrypt.
  const decryptedContent = useDecryptedDraftContent(workspaceId, resolvedDraft, e2eStreamId)

  // Drains the offline queue so a debounced draft push (enqueued by the write
  // helpers) mirrors to the backend promptly instead of waiting for the next
  // reconnect. Optional — outside a workspace (login/loading) there is no engine
  // and the local write still stands.
  const syncEngine = useOptionalSyncEngine()

  // Latest E2E gate for the debounced save: the timer may fire after the stream's
  // encryption/unlock state changed, so the save reads the gate at fire time
  // rather than from a stale closure — this is what keeps a plaintext save
  // scheduled before encryption from ever writing plaintext after it (E2EE-4).
  const e2eGateRef = useRef({ enabled: e2eEnabled, unlocked: e2eUnlocked, senderId, streamId: e2eStreamId ?? null })
  useEffect(() => {
    e2eGateRef.current = { enabled: e2eEnabled, unlocked: e2eUnlocked, senderId, streamId: e2eStreamId ?? null }
  }, [e2eEnabled, e2eUnlocked, senderId, e2eStreamId])

  // Purge only the PLAINTEXT drafts left on disk for an E2E scope (one written
  // before the stream was encrypted, or before the stream row loaded). Sealed
  // rows are the legitimate roaming copy and are kept — only plaintext at rest
  // violates E2EE-4.
  useEffect(() => {
    if (!e2eEnabled) return
    void purgePlaintextScopeDrafts(workspaceId, draftKey)
  }, [e2eEnabled, draftKey, workspaceId])

  /**
   * Persist the composer content for this scope.
   *
   * Returns the row that was written, or `null` when nothing was persisted:
   * the E2E gate refused (locked / no sender / no stream), the seal threw, the
   * save was a deletion (empty content and no attachments), or a resolve-on-send
   * advanced the scope's sequence and the create was dropped. Callers that
   * discard the editor after a save MUST branch on this: on `null` the content
   * exists only on screen, so blanking it loses it.
   */
  const saveDraft = useCallback(
    async (
      contentJson: JSONContent,
      attachments?: DraftAttachment[],
      expectedDraftId?: string | null,
      options?: { keepEmpty?: boolean }
    ): Promise<CachedDraft | null> => {
      // Clear any pending debounced save (synchronously — a cancel must never
      // wait behind the write chain).
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      return chainWrite(async () => {
        // The row this content belongs to. An explicit NON-NULL argument (the
        // debounced save's arm-time id, a repoint flush, a minted detach id) wins;
        // a null/absent one falls through to the ref AS IT STANDS AFTER the
        // predecessor write settled — this in-chain read is the whole point of the
        // serialization: an arm that captured null only because the first create
        // had not resolved yet must inherit that create's identity, not mint a
        // detached fork of its own (live repro: stray "Sh"/"Sho" prefix drafts
        // surviving a send).
        const targetId = expectedDraftId ?? contentDraftId.current
        // Whether this save still speaks for the composer's current content is
        // decided at ASSIGNMENT time, never captured here: the ref can move on
        // (a repoint) during the awaits below, and a stale capture would drag it
        // back to the superseded row.
        const advanceIdentity = (next: string | null) => {
          if (contentDraftId.current === targetId) contentDraftId.current = next
        }

        // A null identity while the scope's pointer references a draft means the
        // editor's content was NEVER hydrated from the pointed-at row (a detach
        // that could not persist, or typing that outran hydration). Falling back
        // to the pointer would write — or delete — a draft this composer does not
        // own, so the save re-routes: non-empty content detaches into its own
        // fresh row (a never-existing expected id takes `upsertLoadedDraft`'s
        // create path without stealing the pointer), and an empty save is a no-op
        // (there is nothing of ours to delete).
        let effectiveTarget = targetId
        let mintedDetachedId = false
        if (strictIdentity && targetId === null && (await getLoadedDraftId(draftKey)) !== null) {
          if (isEmptyContent(contentJson) && (attachments?.length ?? 0) === 0) return null
          effectiveTarget = generateLocalDraftId()
          mintedDetachedId = true
        }
        // A filing-only move may preserve an existing row whose live editor was
        // deliberately cleared, but it must not mint empty drafts from nothing.
        if (options?.keepEmpty && effectiveTarget === null && (await getLoadedDraftId(draftKey)) === null) return null

        // The scope's resolve sequence as this save begins. If a resolve-on-send
        // advances it before the create below runs, this save is a stale echo of
        // the just-sent content and `upsertLoadedDraft` drops its create.
        const observedResolveSeq = getScopeResolveSeq(draftKey)

        const gate = e2eGateRef.current
        if (gate.enabled) {
          // E2EE-4: seal before disk, and only while unlocked. Locked → keep the
          // content in the composer for the session; nothing persists.
          if (!gate.unlocked || !gate.senderId || !gate.streamId) return null
          // Resolve the attachment set: an explicit arg, else the draft's current
          // (decrypted) attachments — a content-only save (a keystroke) must
          // preserve them, exactly as the plaintext path preserves them below. The
          // sealed row holds no plaintext attachments at rest, so they're read back
          // from the in-memory decrypt cache (the plaintext authority).
          const currentLoadedId = effectiveTarget ?? (await getLoadedDraftId(draftKey))
          const finalAttachments = attachments ?? (currentLoadedId ? cachedDraftAttachments(currentLoadedId) : [])
          if (!options?.keepEmpty && isEmptyContent(contentJson) && finalAttachments.length === 0) {
            await clearLoadedDraft(workspaceId, draftKey, effectiveTarget)
            advanceIdentity(null)
            syncEngine?.kickOperationQueue()
            return null
          }
          try {
            const saved = await upsertLoadedDraft(
              workspaceId,
              draftKey,
              { contentJson, attachments: finalAttachments },
              { senderId: gate.senderId, streamId: gate.streamId },
              { observedResolveSeq, expectedDraftId: effectiveTarget, createIfMissing: mintedDetachedId }
            )
            if (!saved) return null
            advanceIdentity(saved.id)
            syncEngine?.kickOperationQueue()
            return isStaleObservedResolve(draftKey, observedResolveSeq) ? null : saved
          } catch (err) {
            // A failed seal (e.g. the session locked between the gate check and the
            // seal) must never interrupt the user — the content stands in the composer.
            console.error("Failed to seal draft; kept in composer", err)
          }
          return null
        }

        // Get current attachments + contextRefs if not provided. The contextRefs
        // sidecar must survive a content-only save (e.g. user typing into a
        // bag-attached scratchpad) — without this preservation the chip would
        // vanish from the composer the moment the first keystroke fires.
        const currentLoadedId = effectiveTarget ?? (await getLoadedDraftId(draftKey))
        const currentDraft = currentLoadedId ? await db.drafts.get(currentLoadedId) : undefined
        const finalAttachments = attachments ?? currentDraft?.attachments ?? []
        const finalContextRefs = currentDraft?.contextRefs ?? []

        // Delete draft only when content + attachments + contextRefs are all empty.
        if (
          !options?.keepEmpty &&
          isEmptyContent(contentJson) &&
          finalAttachments.length === 0 &&
          finalContextRefs.length === 0
        ) {
          await clearLoadedDraft(workspaceId, draftKey, effectiveTarget)
          advanceIdentity(null)
          syncEngine?.kickOperationQueue()
          return null
        }

        const saved = await upsertLoadedDraft(
          workspaceId,
          draftKey,
          { contentJson, attachments: finalAttachments, contextRefs: finalContextRefs },
          undefined,
          { observedResolveSeq, expectedDraftId: effectiveTarget, createIfMissing: mintedDetachedId }
        )
        if (!saved) return null
        advanceIdentity(saved.id)
        syncEngine?.kickOperationQueue()
        return isStaleObservedResolve(draftKey, observedResolveSeq) ? null : saved
      })
    },
    [draftKey, workspaceId, syncEngine, contentDraftId, chainWrite]
  )

  const saveDraftDebounced = useCallback(
    (contentJson: JSONContent) => {
      // Clear any pending debounced save
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      // Synchronously stage the keystroke so a reload before the debounce fires
      // can't lose it (the debounce only reaches IDB after DEBOUNCE_MS). Plaintext
      // only: an E2E draft must never write its body to disk unsealed (E2EE-4), and
      // there is no synchronous seal — its reload-loss window stays open by design.
      // Gate on the render value `e2eEnabled`, not `e2eGateRef` (which trails a
      // prop change by one effect): this runs synchronously at keystroke time, and
      // the callback re-binds when `e2eEnabled` flips, so a stream that just became
      // encrypted never stages a plaintext keystroke. (The seal at timer-fire still
      // reads the ref, the right source for that deferred point.)
      if (!e2eEnabled) stageDraftContent(workspaceId, draftKey, contentJson)
      // Capture the target row at ARM time, not at fire time: the keystrokes in
      // `contentJson` belong to the draft loaded now, and the scope's pointer (and
      // with it the composer's identity) may be repointed before the timer fires.
      const expectedDraftId = contentDraftId.current
      // `saveDraft` reads the live E2E gate when the timer fires, so a value typed
      // while the stream was plaintext is sealed (or dropped) — never written as
      // plaintext — if the stream became encrypted in the meantime (E2EE-4).
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void saveDraft(contentJson, undefined, expectedDraftId)
      }, DEBOUNCE_MS)
    },
    [saveDraft, workspaceId, draftKey, e2eEnabled, contentDraftId]
  )

  /**
   * Add an attachment to the draft. Creates the draft if it doesn't exist.
   */
  const addAttachment = useCallback(
    async (attachment: DraftAttachment) => {
      // The row this attachment operation belongs to, captured ONCE at CALL
      // time: the ref can move on (a repoint) across the awaits below.
      const targetId = contentDraftId.current
      await chainWrite(async () => {
        // Same assignment-time recheck `saveDraft` uses: the ref may have been
        // repointed during the awaits below, and writing the captured target back
        // would drag the composer's identity onto the superseded row.
        const advanceIdentity = (next: string | null) => {
          if (contentDraftId.current === targetId) contentDraftId.current = next
        }
        // Same null-identity rule as `saveDraft`: no identity + a foreign pointer
        // means this composer never hydrated the pointed-at draft, so the
        // attachment must not be sealed/written into it — it detaches to a fresh
        // row instead.
        let effectiveTarget = targetId
        let mintedDetachedId = false
        if (strictIdentity && targetId === null && (await getLoadedDraftId(draftKey)) !== null) {
          effectiveTarget = generateLocalDraftId()
          mintedDetachedId = true
        }
        if (e2eEnabled) {
          // E2EE-4: re-seal the draft with the added attachment. The body + current
          // attachments are the decrypted copy in memory (the row holds only
          // ciphertext at rest); seal both together so the attachment's key/iv ride
          // inside the body's ciphertext (Stage 4d). Locked → can't seal; the
          // attachment stays in the composer session, like a typed body would.
          const gate = e2eGateRef.current
          if (!gate.unlocked || !gate.senderId || !gate.streamId) return
          const sealedLoadedId = effectiveTarget ?? (await getLoadedDraftId(draftKey))
          const currentSealed = sealedLoadedId ? cachedDraftAttachments(sealedLoadedId) : []
          if (currentSealed.some((a) => a.id === attachment.id)) return
          const body = (sealedLoadedId ? cachedDraftBody(sealedLoadedId) : null) ?? EMPTY_DOC
          try {
            const saved = await upsertLoadedDraft(
              workspaceId,
              draftKey,
              { contentJson: body, attachments: [...currentSealed, attachment] },
              { senderId: gate.senderId, streamId: gate.streamId },
              { expectedDraftId: effectiveTarget, createIfMissing: mintedDetachedId }
            )
            if (!saved) return
            advanceIdentity(saved.id)
            syncEngine?.kickOperationQueue()
          } catch (err) {
            console.error("Failed to seal draft attachment; kept in composer", err)
          }
          return
        }
        const currentLoadedId = effectiveTarget ?? (await getLoadedDraftId(draftKey))
        const currentDraft = currentLoadedId ? await db.drafts.get(currentLoadedId) : undefined
        const currentAttachments = currentDraft?.attachments ?? []

        // Don't add duplicates
        if (currentAttachments.some((a) => a.id === attachment.id)) {
          return
        }

        const saved = await upsertLoadedDraft(
          workspaceId,
          draftKey,
          {
            contentJson: currentDraft?.contentJson ?? EMPTY_DOC,
            attachments: [...currentAttachments, attachment],
            // Preserve sidecar so a paste/upload doesn't wipe an attached chip.
            contextRefs: currentDraft?.contextRefs,
          },
          undefined,
          { expectedDraftId: effectiveTarget, createIfMissing: mintedDetachedId }
        )
        if (!saved) return
        advanceIdentity(saved.id)
        syncEngine?.kickOperationQueue()
      })
    },
    [draftKey, workspaceId, e2eEnabled, syncEngine, contentDraftId, chainWrite]
  )

  /**
   * Remove an attachment from the draft.
   * If this leaves the draft empty (no content, no attachments), the draft is deleted.
   */
  const removeAttachment = useCallback(
    async (attachmentId: string) => {
      // The row this attachment operation belongs to, captured ONCE at CALL
      // time: the ref can move on (a repoint) across the awaits below, and
      // reading it later would source the content from one draft and address
      // the write to another.
      const targetId = contentDraftId.current
      await chainWrite(async () => {
        // Assignment-time recheck, as in `addAttachment`/`saveDraft`.
        const advanceIdentity = (next: string | null) => {
          if (contentDraftId.current === targetId) contentDraftId.current = next
        }
        // Null-identity rule (see `saveDraft`): never operate on a pointed-at
        // draft this composer did not hydrate. A fresh id resolves to no row, so
        // every branch below self-no-ops.
        let effectiveTarget = targetId
        let mintedDetachedId = false
        if (strictIdentity && targetId === null && (await getLoadedDraftId(draftKey)) !== null) {
          effectiveTarget = generateLocalDraftId()
          mintedDetachedId = true
        }
        if (e2eEnabled) {
          // E2EE-4: re-seal without the removed attachment (or clear when the draft
          // is left empty). Reads body + attachments from the in-memory decrypt
          // cache for the same reason `addAttachment` does. Locked → no-op.
          const gate = e2eGateRef.current
          if (!gate.unlocked || !gate.senderId || !gate.streamId) return
          const sealedLoadedId = effectiveTarget ?? (await getLoadedDraftId(draftKey))
          if (!sealedLoadedId) return
          const remaining = cachedDraftAttachments(sealedLoadedId).filter((a) => a.id !== attachmentId)
          const body = cachedDraftBody(sealedLoadedId) ?? EMPTY_DOC
          if (isEmptyContent(body) && remaining.length === 0) {
            await clearLoadedDraft(workspaceId, draftKey, effectiveTarget)
            advanceIdentity(null)
            syncEngine?.kickOperationQueue()
            return
          }
          try {
            const saved = await upsertLoadedDraft(
              workspaceId,
              draftKey,
              { contentJson: body, attachments: remaining },
              { senderId: gate.senderId, streamId: gate.streamId },
              { expectedDraftId: effectiveTarget, createIfMissing: mintedDetachedId }
            )
            if (!saved) return
            advanceIdentity(saved.id)
            syncEngine?.kickOperationQueue()
          } catch (err) {
            console.error("Failed to re-seal draft after attachment removal; kept in composer", err)
          }
          return
        }
        const currentLoadedId = effectiveTarget ?? (await getLoadedDraftId(draftKey))
        const currentDraft = currentLoadedId ? await db.drafts.get(currentLoadedId) : undefined
        if (!currentDraft) return

        const remainingAttachments = (currentDraft.attachments ?? []).filter((a) => a.id !== attachmentId)

        // Delete draft if both content and attachments are empty
        if (isEmptyContent(currentDraft.contentJson) && remainingAttachments.length === 0) {
          await clearLoadedDraft(workspaceId, draftKey, effectiveTarget)
          advanceIdentity(null)
          syncEngine?.kickOperationQueue()
          return
        }

        const saved = await upsertLoadedDraft(
          workspaceId,
          draftKey,
          {
            contentJson: currentDraft.contentJson,
            attachments: remainingAttachments,
            contextRefs: currentDraft.contextRefs,
          },
          undefined,
          { expectedDraftId: effectiveTarget, createIfMissing: mintedDetachedId }
        )
        if (!saved) return
        advanceIdentity(saved.id)
        syncEngine?.kickOperationQueue()
      })
    },
    [draftKey, workspaceId, e2eEnabled, syncEngine, contentDraftId, chainWrite]
  )

  /**
   * Drop an armed debounced save WITHOUT persisting it. For the case where the
   * pending keystrokes are known to be moot (the editor is empty and about to be
   * re-hydrated from an arriving draft): letting the timer fire would run a
   * pointer-addressed save with a stale expected id and delete or overwrite the
   * draft that just arrived. `saveDraft` is not a substitute — it persists.
   */
  const cancelPendingSave = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  const clearDraft = useCallback(async () => {
    // Clear any pending debounced save
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    await clearLoadedDraft(workspaceId, draftKey)
    contentDraftId.current = null
    syncEngine?.kickOperationQueue()
  }, [draftKey, workspaceId, syncEngine, contentDraftId])

  /**
   * Clear the loaded draft because its message was sent (resolve-on-send). Same
   * local teardown as `clearDraft`, but the backend removal is CAS-guarded so a
   * draft edited on another device after this send started survives as a stash
   * entry. Used by the send/schedule/command paths; plain discards use
   * `clearDraft`.
   */
  const resolveDraft = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    await resolveLoadedDraft(workspaceId, draftKey)
    contentDraftId.current = null
    syncEngine?.kickOperationQueue()
  }, [draftKey, workspaceId, syncEngine, contentDraftId])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  // The renderable body comes from the shared read path: the decrypted/plaintext
  // content, or the empty placeholder while locked/decrypting/failed/absent (the
  // shared core returns null contentJson for those states).
  const contentJson = decryptedContent.contentJson ?? EMPTY_DOC
  const contentDraftScope = contentDraftId.current
    ? (drafts.find((draft) => draft.id === contentDraftId.current)?.scope ?? null)
    : null

  return {
    /** True once Dexie has loaded and (for an E2E draft) the read has settled (not mid-decrypt). */
    isLoaded: hasSeededDraftCache(workspaceId) && decryptedContent.status !== "pending",
    /** An E2E draft whose sealed body is still being decrypted into the composer. */
    isDecrypting: decryptedContent.status === "pending",
    /** An E2E draft whose body couldn't be decrypted (wrong recipient / garbled). */
    decryptFailed: decryptedContent.status === "failed",
    /**
     * The draft id currently checked out into the composer for this scope, or null.
     * Goes null when the draft is removed underneath the composer — sent/resolved
     * here, or discarded/resolved on another device — which the composer uses to
     * clear the editor so a gone draft doesn't linger.
     */
    loadedDraftId: loadedId,
    /** Current scope of the row whose payload the live editor owns, even while its pointer is moving. */
    contentDraftScope,
    contentJson,
    // Attachments come from the shared read path: a plaintext draft's own
    // `attachments`, or — for a sealed draft — the metadata recovered from the
    // decrypted `attachmentRefs` (empty while locked/decrypting, like the body).
    attachments: decryptedContent.attachments,
    /** Sidecar context refs attached to the draft (see DraftContextRef). */
    contextRefs: (resolvedDraft?.contextRefs ?? []) as DraftContextRef[],
    saveDraft,
    saveDraftDebounced,
    cancelPendingSave,
    addAttachment,
    removeAttachment,
    clearDraft,
    resolveDraft,
  }
}
