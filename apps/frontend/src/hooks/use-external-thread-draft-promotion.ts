import { useEffect, useRef } from "react"
import { draftStreamScope, draftThreadScope } from "@threahq/types"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { relocateLoadedDraft, rescopeScopeDrafts } from "./use-draft-message"

interface ExternalThreadDraftPromotionOptions {
  workspaceId: string
  isDraft: boolean
  anchorId: string | null | undefined
  externalThreadId: string | null | undefined
  flushDraft: (options?: { keepEmpty?: boolean }) => Promise<void>
  setIsSending: (sending: boolean) => void
  onPromoted: (threadId: string) => void
}

/**
 * Preserve a live draft when another actor materializes its thread first.
 * The loaded row keeps its identity while its scope and pointer move; stash
 * siblings then follow through the same lineage-safe scope update.
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
  // The relocation below outlives a panel the user closes mid-flight; its
  // navigation must not reopen what they just closed.
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!isDraft || !anchorId || !externalThreadId || promotionRef.current === externalThreadId) return
    promotionRef.current = externalThreadId
    setIsSending(true)

    void (async () => {
      try {
        // Flush also cancels the composer's armed debounce before relocation.
        await flushDraft({ keepEmpty: true })
        const fromScope = draftThreadScope(anchorId)
        const toScope = draftStreamScope(externalThreadId)
        await relocateLoadedDraft(workspaceId, fromScope, toScope)
        await rescopeScopeDrafts(workspaceId, fromScope, toScope)
        syncEngine?.kickOperationQueue()
        if (!unmountedRef.current) onPromoted(externalThreadId)
      } catch (error) {
        promotionRef.current = null
        setIsSending(false)
        console.error("Failed to preserve draft while opening externally created thread", error)
      }
    })()
  }, [anchorId, externalThreadId, flushDraft, isDraft, onPromoted, setIsSending, syncEngine, workspaceId])
}
