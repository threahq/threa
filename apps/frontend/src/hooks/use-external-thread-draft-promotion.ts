import { useEffect, useRef } from "react"
import { draftStreamScope, draftThreadScope } from "@threa/types"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { relocateLoadedDraft, rescopeScopeDrafts } from "./use-draft-message"

interface ExternalThreadDraftPromotionOptions {
  workspaceId: string
  isDraft: boolean
  anchorId: string | null | undefined
  externalThreadId: string | null | undefined
  flushDraft: () => Promise<void>
  setIsSending: (sending: boolean) => void
  onPromoted: (threadId: string) => void
}

/**
 * Preserve a live draft when another actor materializes its thread first.
 * The loaded row uses the tombstone-safe relocation path; stash siblings can
 * then move normally once no live editor write can resurrect the old scope.
 */
export function useExternalThreadDraftPromotion({
  workspaceId,
  isDraft,
  anchorId,
  externalThreadId,
  flushDraft,
  setIsSending,
  onPromoted,
}: ExternalThreadDraftPromotionOptions): void {
  const syncEngine = useOptionalSyncEngine()
  const promotionRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isDraft || !anchorId || !externalThreadId || promotionRef.current === externalThreadId) return
    promotionRef.current = externalThreadId
    setIsSending(true)

    void (async () => {
      try {
        // Flush also cancels the composer's armed debounce before relocation.
        await flushDraft()
        const fromScope = draftThreadScope(anchorId)
        const toScope = draftStreamScope(externalThreadId)
        await relocateLoadedDraft(workspaceId, fromScope, toScope)
        await rescopeScopeDrafts(workspaceId, fromScope, toScope)
        syncEngine?.kickOperationQueue()
        onPromoted(externalThreadId)
      } catch (error) {
        promotionRef.current = null
        setIsSending(false)
        console.error("Failed to preserve draft while opening externally created thread", error)
      }
    })()
  }, [anchorId, externalThreadId, flushDraft, isDraft, onPromoted, setIsSending, syncEngine, workspaceId])
}
