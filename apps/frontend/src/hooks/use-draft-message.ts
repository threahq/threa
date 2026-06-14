import { useCallback, useEffect, useRef, useState } from "react"
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
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { type JSONContent, draftStreamScope, draftThreadScope } from "@threa/types"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { useE2eSession } from "@/stores/e2e-session-store"
import { decryptDraftContent, sealDraftContent } from "@/lib/crypto/seal-draft"
import { useCurrentWorkspaceUserId } from "./use-current-workspace-user-id"

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

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

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
 * Create or update the draft currently loaded into the composer for `scope`,
 * setting the loaded pointer when a fresh draft is minted. Writes IDB and the
 * in-memory cache together so the composer reflects the change on next paint.
 * Shared by `useDraftMessage` and the context-bag / share-target seeders so a
 * scope never ends up with a draft that no pointer references.
 */
export async function upsertLoadedDraft(workspaceId: string, scope: string, fields: DraftFields): Promise<CachedDraft> {
  const loadedId = await getLoadedDraftId(scope)
  const existing = loadedId ? await db.drafts.get(loadedId) : undefined
  const id = existing?.id ?? generateLocalDraftId()
  const contextRefs = fields.contextRefs && fields.contextRefs.length > 0 ? fields.contextRefs : undefined
  const row: CachedDraft = {
    id,
    workspaceId,
    scope,
    contentJson: fields.contentJson,
    attachments: fields.attachments,
    contextRefs,
    clientUpdatedAt: Date.now(),
    // Carry the sync bookkeeping forward. Without this, editing a
    // confirmed draft would reset baseVersion to undefined, and the next push
    // (expectedVersion 0) would collide with the server's existing row and the
    // server would SPLIT it into a duplicate — once per keystroke after the
    // first sync. Preserve it so the push CAS-updates in place instead.
    baseVersion: existing?.baseVersion,
    attachmentIds: existing?.attachmentIds,
  }
  if (existing) {
    await db.drafts.put(row)
    upsertDraftInCache(workspaceId, row)
  } else {
    // A brand-new loaded draft: write the row and its loaded pointer together so
    // a live reader never observes the draft before the pointer lands — otherwise
    // the just-created draft flashes into its own stash list for a tick (it isn't
    // filtered out as "loaded" until the pointer exists).
    await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
      await db.drafts.put(row)
      await db.composerLoaded.put({ scope, workspaceId, draftId: id })
    })
    upsertLoadedDraftInCache(workspaceId, row, scope)
  }
  // Mirror to the backend: a coalesced, debounced push that retries
  // silently. The caller kicks the queue so it drains promptly.
  await enqueueDraftUpsert(workspaceId, id)
  return row
}

/**
 * Seal-and-persist the loaded draft for an E2E `scope` (Stage 4c). The body is
 * sealed to the stream's SSK before it touches IndexedDB, so only ciphertext is
 * at rest (E2EE-4) — `contentJson` on the row is the empty placeholder and the
 * composer decrypts the body into memory on load. Otherwise mirrors
 * `upsertLoadedDraft`: reuse/mint the loaded id, set the pointer when the draft
 * is new, and enqueue the debounced push (which sends the ciphertext triple).
 *
 * Throws if the session is locked or the SSK can't be resolved — the caller
 * keeps the content in the composer and never surfaces the failure.
 */
export async function upsertLoadedSealedDraft(
  workspaceId: string,
  scope: string,
  fields: { senderId: string; streamId: string; contentJson: JSONContent }
): Promise<void> {
  const loadedId = await getLoadedDraftId(scope)
  const existing = loadedId ? await db.drafts.get(loadedId) : undefined
  const id = existing?.id ?? generateLocalDraftId()
  // The draft id binds the seal AAD (in the message-id slot), so resolve it
  // before sealing — a re-seal of the same draft reuses the id.
  const sealed = await sealDraftContent({
    workspaceId,
    senderId: fields.senderId,
    streamId: fields.streamId,
    draftId: id,
    contentJson: fields.contentJson,
  })
  const row: CachedDraft = {
    id,
    workspaceId,
    scope,
    // E2EE-4: the plaintext never lands on disk — the sealed body is the
    // at-rest copy and `contentJson` is only the empty placeholder.
    contentJson: EMPTY_DOC,
    attachments: [],
    clientUpdatedAt: Date.now(),
    baseVersion: existing?.baseVersion,
    attachmentIds: existing?.attachmentIds,
    ciphertext: sealed.ciphertext,
    envelope: sealed.envelope,
    e2eVersion: sealed.e2eVersion,
  }
  if (existing) {
    await db.drafts.put(row)
    upsertDraftInCache(workspaceId, row)
  } else {
    await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
      await db.drafts.put(row)
      await db.composerLoaded.put({ scope, workspaceId, draftId: id })
    })
    upsertLoadedDraftInCache(workspaceId, row, scope)
  }
  await enqueueDraftUpsert(workspaceId, id)
}

/**
 * Remove the loaded draft for `scope` locally (IDB row + pointer + cache) and
 * report what was removed. Shared by `clearLoadedDraft` (discard) and
 * `resolveLoadedDraft` (send) — they differ only in how the removal is mirrored
 * to the backend, so the local teardown lives on one path (INV-43).
 *
 * The row delete AND the pointer clear happen in ONE transaction. Reading
 * `baseVersion` here also keeps a mid-clear server confirmation from slipping
 * between read and delete (the "ghost draft" race). Crucially the pointer clear
 * is inside the txn too: otherwise a `draft:upserted` echo landing between the
 * row delete and the pointer clear would find no local row and re-insert the
 * just-cleared draft as an orphan stash entry (resurrection race).
 */
async function removeLoadedDraftLocally(
  workspaceId: string,
  scope: string
): Promise<{ loadedId: string | null; baseVersion: number | undefined }> {
  const loadedId = await getLoadedDraftId(scope)
  const baseVersion = await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    let version: number | undefined
    if (loadedId) {
      const row = await db.drafts.get(loadedId)
      version = row?.baseVersion
      await db.drafts.delete(loadedId)
    }
    await db.composerLoaded.delete(scope)
    return version
  })
  if (loadedId) deleteDraftFromCache(workspaceId, loadedId)
  setComposerLoadedInCache(workspaceId, scope, null)
  return { loadedId, baseVersion }
}

/**
 * Discard the loaded draft for `scope` and clear its pointer (stashes survive).
 * The backend mirror is an UNCONDITIONAL delete — the user threw it away, so
 * drift doesn't matter.
 */
export async function clearLoadedDraft(workspaceId: string, scope: string): Promise<void> {
  const { loadedId, baseVersion } = await removeLoadedDraftLocally(workspaceId, scope)
  // Sync side-effect after the local state is fully cleared.
  if (loadedId) await syncDraftRemoval(workspaceId, loadedId, baseVersion)
}

/**
 * Resolve the loaded draft for `scope` after its message sent: remove it locally
 * (same teardown as a discard), but mirror the removal to the backend as a
 * CAS clear-on-send so a copy that drifted on another device survives as a stash
 * entry instead of being collaterally deleted (plan §resolve-on-send).
 */
export async function resolveLoadedDraft(workspaceId: string, scope: string): Promise<void> {
  const { loadedId, baseVersion } = await removeLoadedDraftLocally(workspaceId, scope)
  if (loadedId) await syncDraftResolution(workspaceId, loadedId, baseVersion)
}

/**
 * Delete every draft for `scope` and clear its pointer. Used by the E2E gate to
 * ensure no plaintext draft (loaded or stashed) for a sealed stream stays at
 * rest (E2EE-4).
 */
export async function purgeScopeDrafts(workspaceId: string, scope: string): Promise<void> {
  // Read + delete the rows AND clear the loaded pointer atomically: `baseVersion`
  // reflects any server confirmation that landed before the delete (ghost-draft
  // race), and clearing the pointer inside the txn prevents an inbound echo from
  // re-inserting a just-purged draft as an orphan (resurrection race).
  const rows = await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    const found = await db.drafts.where("[workspaceId+scope]").equals([workspaceId, scope]).toArray()
    for (const row of found) await db.drafts.delete(row.id)
    await db.composerLoaded.delete(scope)
    return found
  })
  for (const row of rows) deleteDraftFromCache(workspaceId, row.id)
  setComposerLoadedInCache(workspaceId, scope, null)
  // Sync side-effects after the local state is fully cleared.
  for (const row of rows) await syncDraftRemoval(workspaceId, row.id, row.baseVersion)
}

/**
 * Delete only the PLAINTEXT drafts for an E2E `scope`, keeping sealed rows. Run
 * on mount of an encrypted-stream composer: a plaintext draft written before the
 * stream was encrypted (or before the seal path existed) must not stay at rest
 * (E2EE-4), but a sealed draft is the legitimate roaming copy and is preserved.
 * The loaded pointer is cleared only when it referenced a purged plaintext row.
 */
export async function purgePlaintextScopeDrafts(workspaceId: string, scope: string): Promise<void> {
  let clearedPointer = false
  const removed = await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    const found = await db.drafts.where("[workspaceId+scope]").equals([workspaceId, scope]).toArray()
    const plaintext = found.filter((row) => !row.ciphertext)
    const loaded = await db.composerLoaded.get(scope)
    for (const row of plaintext) await db.drafts.delete(row.id)
    if (loaded && plaintext.some((row) => row.id === loaded.draftId)) {
      await db.composerLoaded.delete(scope)
      clearedPointer = true
    }
    return plaintext
  })
  for (const row of removed) deleteDraftFromCache(workspaceId, row.id)
  if (clearedPointer) setComposerLoadedInCache(workspaceId, scope, null)
  // Mirror the removal of any plaintext copy that reached the server too.
  for (const row of removed) await syncDraftRemoval(workspaceId, row.id, row.baseVersion)
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
    await migrateLocalDraftScope(workspaceId, fromScope, { ...row, scope: toScope })
    await enqueueDraftUpsert(workspaceId, row.id)
  }
}

/**
 * @param e2eStreamId The encrypted stream the draft seals to — the root stream
 *   whose SSK wraps the body (a thread passes its root). Pass it only for E2E
 *   streams; `undefined`/`null` means plaintext. When set and the session is
 *   unlocked, the body is sealed before it touches disk and decrypted into the
 *   composer on load (Stage 4c, E2EE-4); while the session is locked the composer
 *   behaves as it did before this stage — nothing loads or persists, and the
 *   sealed row waits on disk for unlock. Attachments / context refs / slash
 *   commands on E2E drafts are not sealed yet and stay session-local.
 */
export function useDraftMessage(workspaceId: string, draftKey: string, e2eStreamId?: string | null) {
  const e2eEnabled = !!e2eStreamId
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seal/decrypt need the viewer's workspace user id and unlocked UIK. Both are
  // read here (not threaded from the call site) so the composer reacts when the
  // session unlocks — a locked scope becomes a sealing/decrypting one without a
  // remount.
  const senderId = useCurrentWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, senderId ?? "")
  const e2eUnlocked =
    e2eEnabled && !!senderId && session.status === "unlocked" && !!session.privateKey && !!session.keyId

  const drafts = useDraftsFromStore(workspaceId)
  const loaded = useComposerLoadedFromStore(workspaceId)
  // A locked E2E scope behaves as it did before Stage 4c: nothing is checked out
  // and nothing persists. Only the unlocked path resolves a loaded draft.
  const loadedId = e2eEnabled && !e2eUnlocked ? null : (loaded.find((row) => row.scope === draftKey)?.draftId ?? null)
  const resolvedDraft = loadedId ? drafts.find((draft) => draft.id === loadedId) : undefined

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

  // Decrypt-on-load: an unlocked E2E draft is decrypted into memory once per
  // loaded id. A self-edit re-seals the row under the same id without
  // re-decrypting — the composer holds the live plaintext after it initializes,
  // so this only needs to seed that first paint.
  const [decrypted, setDecrypted] = useState<{ id: string; content: JSONContent } | null>(null)
  const sealedLoaded = e2eUnlocked && resolvedDraft?.ciphertext ? resolvedDraft : undefined
  const decryptReady = !sealedLoaded || decrypted?.id === sealedLoaded.id

  useEffect(() => {
    if (!sealedLoaded?.ciphertext || !e2eStreamId || !session.privateKey || !session.keyId) return
    if (decrypted?.id === sealedLoaded.id) return
    let cancelled = false
    void decryptDraftContent({
      ciphertext: sealedLoaded.ciphertext,
      envelope: sealedLoaded.envelope,
      e2eVersion: sealedLoaded.e2eVersion,
      workspaceId,
      streamId: e2eStreamId,
      privateKey: session.privateKey,
      recipientKeyId: session.keyId,
    }).then((content) => {
      // A null result is a transient/blocked decrypt (session locked mid-flight,
      // key not yet resolvable). Leave `decrypted` unset so the effect retries
      // when a dep changes (e.g. the session unlocks) instead of baking an empty
      // body in — which the same-id guard would then make permanent, inviting the
      // user to type over a still-recoverable sealed draft.
      if (!cancelled && content) setDecrypted({ id: sealedLoaded.id, content })
    })
    return () => {
      cancelled = true
    }
  }, [sealedLoaded, e2eStreamId, session.privateKey, session.keyId, workspaceId, decrypted?.id])

  // Drop the decrypted plaintext when the scope changes so a navigated-away
  // draft's body never lingers in memory and the new scope re-decrypts cleanly.
  useEffect(() => {
    setDecrypted(null)
  }, [draftKey])

  // Purge only the PLAINTEXT drafts left on disk for an E2E scope (one written
  // before the stream was encrypted, or before the seal path existed). Sealed
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

      const gate = e2eGateRef.current
      if (gate.enabled) {
        // E2EE-4: seal before disk, and only while unlocked. Locked → keep the
        // content in the composer for the session; nothing persists. v1 seals the
        // body only, so an `attachments` arg is intentionally ignored here.
        if (!gate.unlocked || !gate.senderId || !gate.streamId) return
        if (isEmptyContent(contentJson)) {
          await clearLoadedDraft(workspaceId, draftKey)
          syncEngine?.kickOperationQueue()
          return
        }
        try {
          await upsertLoadedSealedDraft(workspaceId, draftKey, {
            senderId: gate.senderId,
            streamId: gate.streamId,
            contentJson,
          })
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

      await upsertLoadedDraft(workspaceId, draftKey, {
        contentJson,
        attachments: finalAttachments,
        contextRefs: finalContextRefs,
      })
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
      // `saveDraft` reads the live E2E gate when the timer fires, so a value typed
      // while the stream was plaintext is sealed (or dropped) — never written as
      // plaintext — if the stream became encrypted in the meantime (E2EE-4).
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void saveDraft(contentJson)
      }, DEBOUNCE_MS)
    },
    [saveDraft]
  )

  /**
   * Add an attachment to the draft. Creates the draft if it doesn't exist.
   */
  const addAttachment = useCallback(
    async (attachment: DraftAttachment) => {
      // E2EE-4: encrypted-stream drafts (incl. attachment metadata) stay in memory.
      if (e2eEnabled) return
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
      if (e2eEnabled) return
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

  // For an unlocked E2E draft the renderable content is the in-memory decrypt,
  // not the on-disk placeholder; everything else reads straight off the row.
  const decryptedForLoaded =
    sealedLoaded && decrypted && decrypted.id === sealedLoaded.id ? decrypted.content : EMPTY_DOC
  const contentJson = e2eUnlocked ? decryptedForLoaded : (resolvedDraft?.contentJson ?? EMPTY_DOC)

  return {
    /** True once Dexie has loaded and (for an unlocked E2E draft) decryption has resolved. */
    isLoaded: hasSeededDraftCache(workspaceId) && decryptReady,
    contentJson,
    attachments: resolvedDraft?.attachments ?? [],
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
