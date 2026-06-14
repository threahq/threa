import { useCallback, useEffect, useRef } from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { useStashedDrafts, type CachedDraft } from "./use-stashed-drafts"
import type { DraftComposerState } from "./use-draft-composer"
import type { DraftAttachment } from "@/db"
import type { PendingAttachment } from "./use-attachments"

/** Distil the uploaded-attachment snapshot the stash pile persists. */
function snapshotUploadedAttachments(pending: PendingAttachment[]): DraftAttachment[] {
  return pending
    .filter((a) => a.status === "uploaded" && !a.id.startsWith("temp_"))
    .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes }))
}

export interface UseStashComposerResult {
  /** Stashed drafts for the current scope, newest first. Empty when `scope` is undefined. */
  drafts: CachedDraft[]
  /** Snapshot the current composer content + attachments into the stash, clear the editor, toast. Empty composer → silent no-op. */
  handleStashDraft: () => Promise<void>
  /** Swap: stash current content first (if any), then load the chosen stashed row into the composer. */
  handleRestoreStashed: (id: string) => Promise<void>
  /** Delete a stashed row without restoring. */
  handleDeleteStashed: (id: string) => Promise<void>
}

/**
 * Binds the stashed-drafts pile (`useStashedDrafts`) to a `DraftComposerState`
 * so the two composer hosts (`MessageInput` and `StreamPanel`) don't each
 * carry their own copy of the stash / restore / delete callbacks. The hook
 * also owns the `?stash=<id>` URL auto-restore: the param is consumed
 * _after_ the restore resolves so a mid-flight failure doesn't silently
 * strip the deep link — a refresh will retry (dedup via a ref prevents
 * loops within a single mount).
 */
export function useStashComposer(
  composer: DraftComposerState,
  workspaceId: string,
  scope: string | undefined,
  // Stashing snapshots the composer's plaintext content, so it is disabled for
  // encrypted streams in v1 (E2EE-4): the ambient draft still roams sealed, but
  // the manual save-for-later pile is a follow-up. Both stash + restore no-op
  // when set, so every trigger (button, keyboard, `?stash=` URL) is covered.
  e2eEnabled = false
): UseStashComposerResult {
  const stashedDrafts = useStashedDrafts(workspaceId, scope)

  const handleStashDraft = useCallback(async () => {
    if (e2eEnabled) return // E2EE-4: never snapshot encrypted-stream plaintext into a stash row.
    const row = await stashedDrafts.stashDraft({
      contentJson: composer.content,
      attachments: snapshotUploadedAttachments(composer.pendingAttachments),
    })
    if (!row) return // Empty composer: silent no-op per product brief.

    composer.setContent(EMPTY_DOC)
    await composer.clearDraft()
    composer.clearAttachments()
    toast.success("Saved as draft")
  }, [composer, stashedDrafts, e2eEnabled])

  const handleRestoreStashed = useCallback(
    async (id: string) => {
      // Encrypted streams don't expose the stash in v1: a restore would both
      // snapshot the composer's plaintext (E2EE-4) and load a sealed row's empty
      // placeholder. No-op so the `?stash=` deep link can't trip either.
      if (e2eEnabled) return
      // Swap semantics: stash whatever the composer holds first so switching
      // drafts never silently destroys work. A thrown error here (e.g. IDB
      // quota) is swallowed — losing a recent auto-save is a smaller harm
      // than aborting the deliberate restore of an explicit stash row.
      try {
        await stashedDrafts.stashDraft({
          contentJson: composer.content,
          attachments: snapshotUploadedAttachments(composer.pendingAttachments),
        })
      } catch (err) {
        console.error("Failed to stash current content before restoring", err)
      }

      const row = await stashedDrafts.restoreStashedDraft(id)
      if (!row) return

      composer.clearAttachments()
      composer.setContent(row.contentJson)
      // handleContentChange drives the debounced write into DraftMessage
      // once the editor picks up the new content.
      composer.handleContentChange(row.contentJson)
      if (row.attachments && row.attachments.length > 0) {
        composer.restoreAttachments(row.attachments)
      }
      toast.success("Draft restored")
    },
    [composer, stashedDrafts, e2eEnabled]
  )

  const handleDeleteStashed = useCallback(
    async (id: string) => {
      await stashedDrafts.deleteStashedDraft(id)
    },
    [stashedDrafts]
  )

  // Auto-restore when the URL carries `?stash=<id>` — how the /drafts
  // explorer deep-links to a specific snapshot. The dedup ref prevents the
  // same id firing twice within one mount if React re-runs the effect, and
  // the param is stripped only after the restore resolves so a thrown
  // error doesn't silently eat the deep link.
  const [searchParams, setSearchParams] = useSearchParams()
  const pendingStashRestoreRef = useRef<string | null>(null)
  useEffect(() => {
    const stashId = searchParams.get("stash")
    if (!stashId || !scope || !composer.isLoaded) return
    if (pendingStashRestoreRef.current === stashId) return

    pendingStashRestoreRef.current = stashId

    handleRestoreStashed(stashId).then(
      () => {
        const nextParams = new URLSearchParams(searchParams)
        nextParams.delete("stash")
        setSearchParams(nextParams, { replace: true })
      },
      (err) => {
        // Keep the param so a refresh can retry; dedup ref still prevents
        // a loop within this mount.
        console.error("Failed to auto-restore stashed draft from URL", err)
      }
    )
  }, [searchParams, setSearchParams, scope, composer.isLoaded, handleRestoreStashed])

  return {
    drafts: stashedDrafts.drafts,
    handleStashDraft,
    handleRestoreStashed,
    handleDeleteStashed,
  }
}
