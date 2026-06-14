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
import { enqueueDraftUpsert, syncDraftRemoval } from "@/sync/draft-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import type { JSONContent } from "@threa/types"
import { isEmptyContent } from "@/lib/prosemirror-utils"

// Key formats (a draft's `scope`):
// - "stream:{streamId}" for messages in existing streams
// - "thread:{parentMessageId}" for new threads (reply to a message that doesn't have a thread yet)
export function getDraftMessageKey(
  location: { type: "stream"; streamId: string } | { type: "thread"; parentMessageId: string }
): string {
  if (location.type === "stream") {
    return `stream:${location.streamId}`
  }
  return `thread:${location.parentMessageId}`
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

/** Delete the loaded draft for `scope` and clear its pointer (stashes survive). */
export async function clearLoadedDraft(workspaceId: string, scope: string): Promise<void> {
  const loadedId = await getLoadedDraftId(scope)
  // Delete the draft row AND clear its loaded pointer in ONE transaction. Reading
  // `baseVersion` here also keeps a mid-clear server confirmation from slipping
  // between read and delete (the "ghost draft" race). Crucially the pointer clear
  // is inside the txn too: otherwise a `draft:upserted` echo landing between the
  // row delete and the pointer clear would find no local row and re-insert the
  // just-cleared draft as an orphan stash entry (resurrection race).
  const removedBaseVersion = await db.transaction("rw", db.drafts, db.composerLoaded, async () => {
    let baseVersion: number | undefined
    if (loadedId) {
      const row = await db.drafts.get(loadedId)
      baseVersion = row?.baseVersion
      await db.drafts.delete(loadedId)
    }
    await db.composerLoaded.delete(scope)
    return baseVersion
  })
  if (loadedId) deleteDraftFromCache(workspaceId, loadedId)
  setComposerLoadedInCache(workspaceId, scope, null)
  // Sync side-effect after the local state is fully cleared.
  if (loadedId) await syncDraftRemoval(workspaceId, loadedId, removedBaseVersion)
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
 * @param e2eEnabled When the draft belongs to an end-to-end-encrypted stream,
 *   persistence and restore are disabled (E2EE-4): the composer keeps content in
 *   memory for the session only, so no plaintext draft for a sealed scratchpad
 *   ever touches IndexedDB or survives lock/reload. Any draft persisted before
 *   this gate existed is purged on mount.
 */
export function useDraftMessage(workspaceId: string, draftKey: string, e2eEnabled = false) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read inside the debounced timer so a save scheduled while the stream was
  // plaintext can't write after the stream becomes encrypted (E2EE-4).
  const e2eEnabledRef = useRef(e2eEnabled)
  const drafts = useDraftsFromStore(workspaceId)
  const loaded = useComposerLoadedFromStore(workspaceId)
  const loadedId = e2eEnabled ? null : (loaded.find((row) => row.scope === draftKey)?.draftId ?? null)
  const resolvedDraft = loadedId ? drafts.find((draft) => draft.id === loadedId) : undefined
  // Drains the offline queue so a debounced draft push (enqueued by the write
  // helpers) mirrors to the backend promptly instead of waiting for the next
  // reconnect. Optional — outside a workspace (login/loading) there is no engine
  // and the local write still stands.
  const syncEngine = useOptionalSyncEngine()

  // When a stream becomes encrypted, cancel any debounced plaintext save still
  // in flight — otherwise it fires after the purge below and re-persists the
  // very plaintext we just deleted (write-after-purge race, E2EE-4).
  useEffect(() => {
    e2eEnabledRef.current = e2eEnabled
    if (e2eEnabled && debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [e2eEnabled])

  // Purge any pre-existing on-disk draft for an E2E stream (e.g. one written
  // before this gate landed, or carried over when a stream is encrypted).
  useEffect(() => {
    if (!e2eEnabled) return
    void purgeScopeDrafts(workspaceId, draftKey)
  }, [e2eEnabled, draftKey, workspaceId])

  const saveDraft = useCallback(
    async (contentJson: JSONContent, attachments?: DraftAttachment[]) => {
      // E2EE-4: encrypted-stream drafts are never written to disk.
      if (e2eEnabled) return
      // Clear any pending debounced save
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
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
    [draftKey, workspaceId, e2eEnabled, syncEngine]
  )

  const saveDraftDebounced = useCallback(
    (contentJson: JSONContent) => {
      // E2EE-4: encrypted-stream drafts are never written to disk.
      if (e2eEnabled) return
      // Clear any pending debounced save
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }

      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        // The stream may have been encrypted between scheduling and firing;
        // never write plaintext to disk in that case (E2EE-4).
        if (e2eEnabledRef.current) return
        saveDraft(contentJson)
      }, DEBOUNCE_MS)
    },
    [saveDraft, e2eEnabled]
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

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  return {
    /** Whether Dexie has finished loading the draft (true even if no draft exists) */
    isLoaded: hasSeededDraftCache(workspaceId),
    contentJson: resolvedDraft?.contentJson ?? EMPTY_DOC,
    attachments: resolvedDraft?.attachments ?? [],
    /** Sidecar context refs attached to the draft (see DraftContextRef). */
    contextRefs: (resolvedDraft?.contextRefs ?? []) as DraftContextRef[],
    saveDraft,
    saveDraftDebounced,
    addAttachment,
    removeAttachment,
    clearDraft,
  }
}
