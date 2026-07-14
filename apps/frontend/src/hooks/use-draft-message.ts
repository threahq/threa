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
import { getScopeResolveSeq, markDraftResolved, recordScopeResolved } from "@/sync/draft-resolution-guard"
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
// - "thread:{parentMessageId}" for new threads (reply to a message that doesn't have a thread yet)
export function getDraftMessageKey(
  location: { type: "stream"; streamId: string } | { type: "thread"; parentMessageId: string }
): string {
  if (location.type === "stream") {
    return draftStreamScope(location.streamId)
  }
  return draftThreadScope(location.parentMessageId)
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
export async function upsertLoadedDraft(
  workspaceId: string,
  scope: string,
  fields: DraftFields,
  seal?: DraftSealContext,
  /**
   * The scope's resolve sequence observed when this save began. Passed only by
   * the debounced typing save: if a resolve-on-send advanced the sequence while
   * the save was in flight, creating a draft here would resurrect the just-sent
   * content into the composer, so the create is dropped. Other create paths pass
   * nothing and are never affected.
   */
  opts?: { observedResolveSeq?: number }
): Promise<CachedDraft> {
  // The save's target identity is re-validated INSIDE the write transaction:
  // a split ack can migrate the loaded draft's id (and a push ack can advance
  // its baseVersion) between our reads and our write. Writing against the
  // stale identity would resurrect the pre-split id as a duplicate row — one
  // that re-pushes, re-splits, and breeds copies — so on a mismatch we retry
  // against the new identity instead. Two retries bound the loop; a save that
  // still conflicts is dropped — the content stands in the editor (and, for
  // plaintext scopes, the staging buffer) until the next keystroke re-saves.
  let row!: CachedDraft
  for (let attempt = 0; attempt < 3; attempt++) {
    const loadedId = await getLoadedDraftId(scope)
    const existing = loadedId ? await db.drafts.get(loadedId) : undefined
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
    const outcome = await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
      if (isStaleObservedResolve(scope, opts?.observedResolveSeq)) return "dropped"
      const livePointer = (await db.composerLoaded.get(scope))?.draftId ?? null
      if (livePointer !== loadedId) return "conflict"
      if (existing) {
        const liveRow = await db.drafts.get(id)
        if (!liveRow) return "conflict"
        // Freshest sync bookkeeping wins: a push ack can advance baseVersion
        // between our read and this txn, and writing the stale value back would
        // make the next push CAS against an old version and split.
        row = seal
          ? { ...row, baseVersion: liveRow.baseVersion }
          : { ...row, baseVersion: liveRow.baseVersion, attachmentIds: liveRow.attachmentIds }
        await db.drafts.put(row)
      } else {
        await db.drafts.put(row)
        await db.composerLoaded.put({ scope, workspaceId, draftId: id })
      }
      // Mirror to the backend: a coalesced push that retries silently. The
      // caller kicks the queue so it drains promptly.
      await enqueueDraftUpsert(workspaceId, id)
      return "persisted"
    })

    if (outcome === "conflict") continue
    if (outcome === "dropped") return row
    if (existing) {
      upsertDraftInCache(workspaceId, row)
    } else {
      upsertLoadedDraftInCache(workspaceId, row, scope)
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
  mirror: (loadedId: string, baseVersion: number | undefined) => Promise<void>
): Promise<void> {
  let removedId: string | null = null
  await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
    const loadedId = (await db.composerLoaded.get(scope))?.draftId ?? null
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
export async function clearLoadedDraft(workspaceId: string, scope: string): Promise<void> {
  // Drop the staging buffer first (synchronous) so a racing flush or a reload
  // can't recover the discarded content back into the composer.
  clearStagedDraft(workspaceId, scope)
  await removeLoadedDraftLocally(workspaceId, scope, (loadedId, baseVersion) =>
    syncDraftRemoval(workspaceId, loadedId, baseVersion)
  )
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
export async function stashLoadedDraft(workspaceId: string, scope: string): Promise<string | null> {
  const draftId = (await db.composerLoaded.get(scope))?.draftId ?? null
  if (!draftId) return null
  // The caller flushed the live editor into the row before stashing, so the
  // staged buffer is now redundant; drop it so a reload doesn't recover the
  // stashed body back into the (now draft-less) composer as a new loaded draft.
  clearStagedDraft(workspaceId, scope)
  await db.composerLoaded.delete(scope)
  setComposerLoadedInCache(workspaceId, scope, null)
  return draftId
}

/**
 * Restore stash entry `draftId` into the composer for `scope` by pointing the
 * scope at it. Whatever was loaded becomes a stash entry automatically (the scope
 * points at exactly one draft), so this is a swap that never loses work. The row's
 * body — plaintext or sealed — is untouched; the composer decrypts on read. Like
 * stash, it is a pure pointer move: no snapshot, no server round-trip (the row was
 * already pushed when it was last edited).
 */
export async function restoreStashedDraftToComposer(
  workspaceId: string,
  scope: string,
  draftId: string
): Promise<void> {
  // Drop the staging buffer: it holds the keystrokes for the draft being swapped
  // OUT (already flushed to its own row by the caller), so leaving it would let a
  // reload before the next keystroke recover that stale body over the draft we
  // just restored — corrupting it. The restored draft re-stages on its first edit.
  clearStagedDraft(workspaceId, scope)
  await db.composerLoaded.put({ scope, workspaceId, draftId })
  setComposerLoadedInCache(workspaceId, scope, draftId)
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
 * Move the loaded draft's content out of `fromScope` into a FRESH loaded draft
 * under `toScope`, deleting the source draft. The race-proof alternative to
 * `rescopeScopeDrafts` for a scope a LIVE editor is leaving: an in-flight push
 * snapshotted before a row-move can land after it and reinstate the old scope
 * server-side (last write wins) — no enqueue-layer ordering can prevent that.
 * Deleting the source instead rides the delete machinery's tombstone
 * (`supersededWriteIds`), which is designed to suppress exactly those late
 * pushes; the target row is brand-new, so it has no version history to fight.
 *
 * `liveContent` is the editor's current document (keystrokes may not have
 * flushed); it wins over the persisted body. An existing loaded draft under
 * `toScope` is stashed first, never clobbered (cardinal no-loss rule). Stash
 * siblings under `fromScope` stay put — they were deliberately stashed against
 * that target. No-op (source still cleared) when there is nothing to move.
 */
export async function relocateLoadedDraft(
  workspaceId: string,
  fromScope: string,
  toScope: string,
  liveContent?: JSONContent
): Promise<void> {
  const loadedId = (await db.composerLoaded.get(fromScope))?.draftId ?? null
  const row = loadedId ? await db.drafts.get(loadedId) : null
  const contentJson = liveContent && !isEmptyContent(liveContent) ? liveContent : (row?.contentJson ?? EMPTY_DOC)
  const attachments = row?.attachments ?? []

  if (!isEmptyContent(contentJson) || attachments.length > 0) {
    await stashLoadedDraft(workspaceId, toScope)
    await upsertLoadedDraft(workspaceId, toScope, { contentJson, attachments })
  }
  await clearLoadedDraft(workspaceId, fromScope)
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
export function useDraftMessage(workspaceId: string, draftKey: string, e2eStreamId?: string | null) {
  const e2eEnabled = !!e2eStreamId
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const saveDraft = useCallback(
    async (contentJson: JSONContent, attachments?: DraftAttachment[]) => {
      // Clear any pending debounced save
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }

      // The scope's resolve sequence as this save begins. If a resolve-on-send
      // advances it before the create below runs, this save is a stale echo of
      // the just-sent content and `upsertLoadedDraft` drops its create.
      const observedResolveSeq = getScopeResolveSeq(draftKey)

      const gate = e2eGateRef.current
      if (gate.enabled) {
        // E2EE-4: seal before disk, and only while unlocked. Locked → keep the
        // content in the composer for the session; nothing persists.
        if (!gate.unlocked || !gate.senderId || !gate.streamId) return
        // Resolve the attachment set: an explicit arg, else the draft's current
        // (decrypted) attachments — a content-only save (a keystroke) must
        // preserve them, exactly as the plaintext path preserves them below. The
        // sealed row holds no plaintext attachments at rest, so they're read back
        // from the in-memory decrypt cache (the plaintext authority).
        const currentLoadedId = await getLoadedDraftId(draftKey)
        const finalAttachments = attachments ?? (currentLoadedId ? cachedDraftAttachments(currentLoadedId) : [])
        if (isEmptyContent(contentJson) && finalAttachments.length === 0) {
          await clearLoadedDraft(workspaceId, draftKey)
          syncEngine?.kickOperationQueue()
          return
        }
        try {
          await upsertLoadedDraft(
            workspaceId,
            draftKey,
            { contentJson, attachments: finalAttachments },
            { senderId: gate.senderId, streamId: gate.streamId },
            { observedResolveSeq }
          )
          syncEngine?.kickOperationQueue()
        } catch (err) {
          // A failed seal (e.g. the session locked between the gate check and the
          // seal) must never interrupt the user — the content stands in the composer.
          console.error("Failed to seal draft; kept in composer", err)
        }
        return
      }

      // Get current attachments + contextRefs if not provided. The contextRefs
      // sidecar must survive a content-only save (e.g. user typing into a
      // bag-attached scratchpad) — without this preservation the chip would
      // vanish from the composer the moment the first keystroke fires.
      const currentLoadedId = await getLoadedDraftId(draftKey)
      const currentDraft = currentLoadedId ? await db.drafts.get(currentLoadedId) : undefined
      const finalAttachments = attachments ?? currentDraft?.attachments ?? []
      const finalContextRefs = currentDraft?.contextRefs ?? []

      // Delete draft only when content + attachments + contextRefs are all empty.
      if (isEmptyContent(contentJson) && finalAttachments.length === 0 && finalContextRefs.length === 0) {
        await clearLoadedDraft(workspaceId, draftKey)
        syncEngine?.kickOperationQueue()
        return
      }

      await upsertLoadedDraft(
        workspaceId,
        draftKey,
        { contentJson, attachments: finalAttachments, contextRefs: finalContextRefs },
        undefined,
        { observedResolveSeq }
      )
      syncEngine?.kickOperationQueue()
    },
    [draftKey, workspaceId, syncEngine]
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
      // `saveDraft` reads the live E2E gate when the timer fires, so a value typed
      // while the stream was plaintext is sealed (or dropped) — never written as
      // plaintext — if the stream became encrypted in the meantime (E2EE-4).
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void saveDraft(contentJson)
      }, DEBOUNCE_MS)
    },
    [saveDraft, workspaceId, draftKey, e2eEnabled]
  )

  /**
   * Add an attachment to the draft. Creates the draft if it doesn't exist.
   */
  const addAttachment = useCallback(
    async (attachment: DraftAttachment) => {
      if (e2eEnabled) {
        // E2EE-4: re-seal the draft with the added attachment. The body + current
        // attachments are the decrypted copy in memory (the row holds only
        // ciphertext at rest); seal both together so the attachment's key/iv ride
        // inside the body's ciphertext (Stage 4d). Locked → can't seal; the
        // attachment stays in the composer session, like a typed body would.
        const gate = e2eGateRef.current
        if (!gate.unlocked || !gate.senderId || !gate.streamId) return
        const sealedLoadedId = await getLoadedDraftId(draftKey)
        const currentSealed = sealedLoadedId ? cachedDraftAttachments(sealedLoadedId) : []
        if (currentSealed.some((a) => a.id === attachment.id)) return
        const body = (sealedLoadedId ? cachedDraftBody(sealedLoadedId) : null) ?? EMPTY_DOC
        try {
          await upsertLoadedDraft(
            workspaceId,
            draftKey,
            { contentJson: body, attachments: [...currentSealed, attachment] },
            { senderId: gate.senderId, streamId: gate.streamId }
          )
          syncEngine?.kickOperationQueue()
        } catch (err) {
          console.error("Failed to seal draft attachment; kept in composer", err)
        }
        return
      }
      const currentLoadedId = await getLoadedDraftId(draftKey)
      const currentDraft = currentLoadedId ? await db.drafts.get(currentLoadedId) : undefined
      const currentAttachments = currentDraft?.attachments ?? []

      // Don't add duplicates
      if (currentAttachments.some((a) => a.id === attachment.id)) {
        return
      }

      await upsertLoadedDraft(workspaceId, draftKey, {
        contentJson: currentDraft?.contentJson ?? EMPTY_DOC,
        attachments: [...currentAttachments, attachment],
        // Preserve sidecar so a paste/upload doesn't wipe an attached chip.
        contextRefs: currentDraft?.contextRefs,
      })
      syncEngine?.kickOperationQueue()
    },
    [draftKey, workspaceId, e2eEnabled, syncEngine]
  )

  /**
   * Remove an attachment from the draft.
   * If this leaves the draft empty (no content, no attachments), the draft is deleted.
   */
  const removeAttachment = useCallback(
    async (attachmentId: string) => {
      if (e2eEnabled) {
        // E2EE-4: re-seal without the removed attachment (or clear when the draft
        // is left empty). Reads body + attachments from the in-memory decrypt
        // cache for the same reason `addAttachment` does. Locked → no-op.
        const gate = e2eGateRef.current
        if (!gate.unlocked || !gate.senderId || !gate.streamId) return
        const sealedLoadedId = await getLoadedDraftId(draftKey)
        if (!sealedLoadedId) return
        const remaining = cachedDraftAttachments(sealedLoadedId).filter((a) => a.id !== attachmentId)
        const body = cachedDraftBody(sealedLoadedId) ?? EMPTY_DOC
        if (isEmptyContent(body) && remaining.length === 0) {
          await clearLoadedDraft(workspaceId, draftKey)
          syncEngine?.kickOperationQueue()
          return
        }
        try {
          await upsertLoadedDraft(
            workspaceId,
            draftKey,
            { contentJson: body, attachments: remaining },
            { senderId: gate.senderId, streamId: gate.streamId }
          )
          syncEngine?.kickOperationQueue()
        } catch (err) {
          console.error("Failed to re-seal draft after attachment removal; kept in composer", err)
        }
        return
      }
      const currentLoadedId = await getLoadedDraftId(draftKey)
      const currentDraft = currentLoadedId ? await db.drafts.get(currentLoadedId) : undefined
      if (!currentDraft) return

      const remainingAttachments = (currentDraft.attachments ?? []).filter((a) => a.id !== attachmentId)

      // Delete draft if both content and attachments are empty
      if (isEmptyContent(currentDraft.contentJson) && remainingAttachments.length === 0) {
        await clearLoadedDraft(workspaceId, draftKey)
        syncEngine?.kickOperationQueue()
        return
      }

      await upsertLoadedDraft(workspaceId, draftKey, {
        contentJson: currentDraft.contentJson,
        attachments: remainingAttachments,
        contextRefs: currentDraft.contextRefs,
      })
      syncEngine?.kickOperationQueue()
    },
    [draftKey, workspaceId, e2eEnabled, syncEngine]
  )

  const clearDraft = useCallback(async () => {
    // Clear any pending debounced save
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    await clearLoadedDraft(workspaceId, draftKey)
    syncEngine?.kickOperationQueue()
  }, [draftKey, workspaceId, syncEngine])

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
    syncEngine?.kickOperationQueue()
  }, [draftKey, workspaceId, syncEngine])

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
    contentJson,
    // Attachments come from the shared read path: a plaintext draft's own
    // `attachments`, or — for a sealed draft — the metadata recovered from the
    // decrypted `attachmentRefs` (empty while locked/decrypting, like the body).
    attachments: decryptedContent.attachments,
    /** Sidecar context refs attached to the draft (see DraftContextRef). */
    contextRefs: (resolvedDraft?.contextRefs ?? []) as DraftContextRef[],
    saveDraft,
    saveDraftDebounced,
    addAttachment,
    removeAttachment,
    clearDraft,
    resolveDraft,
  }
}
