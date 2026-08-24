import { useCallback } from "react"
import type { AgentBlockData } from "@/components/timeline/agent-block-context"
import { newAsideDraftScope } from "@/lib/drafts/aside-scope"
import {
  asideOpenDraft,
  clearAsideAgentBlocks,
  closeAside,
  queueAsideAgentBlock,
  setAsideOpenDraft,
  useAsideOpenDraft,
  useAsidePendingAgentBlocks,
} from "@/stores/aside-store"
import { useAsideHandoff } from "@/hooks/use-aside-handoff"
import type { AsideDraftHandoff } from "@/hooks/use-aside-draft-actions"
import { useDeleteAsideDraft } from "./use-aside-drafts"

export interface AsideDraftSurface {
  /** The draft open for writing, or null when the strip is just a strip. */
  openScope: string | null
  openDraft: (scope: string) => void
  closeDraft: () => void
  /** Start a new draft in this aside and open it. */
  startDraft: () => void
  /** Throw a draft away, open or not. */
  discardDraft: (scope: string) => void
  /** Agent replies queued by "Insert into draft", waiting for the editor to load. */
  pendingAgentBlocks: AgentBlockData[]
  insertAgentBlock: (data: AgentBlockData) => void
  consumePendingAgentBlocks: () => void
  sendToComposer: (handoff: AsideDraftHandoff) => Promise<{ delivered: Promise<boolean> } | null>
}

/**
 * The state the aside's two halves share: which draft is open, what Ariadne
 * has queued for it, and the one way content leaves. The first two live in the
 * aside store rather than here: the stage and the phone sheet are different
 * components, so anything this hook owned outright would be destroyed crossing
 * between them — the open draft mid-sentence, and a queued block still waiting
 * for the editor to hydrate.
 */
export function useAsideDraftSurface(params: {
  workspaceId: string
  asideId: string
  hostStreamId: string
  originScope: string
}): AsideDraftSurface {
  const { workspaceId, asideId, hostStreamId, originScope } = params
  const openScope = useAsideOpenDraft(asideId)
  const pendingAgentBlocks = useAsidePendingAgentBlocks(asideId)

  // "Insert into draft" on one of Ariadne's replies: the block goes into an
  // aside draft — the open one, else a new one — never into the chat composer
  // (that would address it back to Ariadne). Queued here because the editor
  // mounts with the draft; it appends the blocks once the draft has loaded.
  const insertAgentBlock = useCallback(
    (data: AgentBlockData) => {
      queueAsideAgentBlock(asideId, data)
      setAsideOpenDraft(asideId, asideOpenDraft(asideId) ?? newAsideDraftScope(asideId))
    },
    [asideId]
  )
  const consumePendingAgentBlocks = useCallback(() => clearAsideAgentBlocks(asideId), [asideId])

  const handoff = useAsideHandoff(workspaceId)
  const sendToComposer = useCallback(
    async ({ content, attachments }: AsideDraftHandoff) => {
      const queued = await handoff({ hostStreamId, originScope, content, attachments })
      // Get out of the composer's way once the blocks are on their way to it.
      // The aside closes rather than parking: its anchor row is still in the
      // timeline, and that is the one way back in.
      if (queued) closeAside()
      return queued
    },
    [handoff, hostStreamId, originScope]
  )

  const openDraft = useCallback((scope: string) => setAsideOpenDraft(asideId, scope), [asideId])
  const closeDraft = useCallback(() => setAsideOpenDraft(asideId, null), [asideId])
  const startDraft = useCallback(() => setAsideOpenDraft(asideId, newAsideDraftScope(asideId)), [asideId])

  const deleteDraft = useDeleteAsideDraft(workspaceId)
  const discardDraft = useCallback(
    (scope: string) => {
      // Closed first: the editor's teardown flush would otherwise re-save the
      // draft it is still holding, moments after the row was deleted.
      if (asideOpenDraft(asideId) === scope) setAsideOpenDraft(asideId, null)
      void deleteDraft(scope)
    },
    [asideId, deleteDraft]
  )

  return {
    openScope,
    openDraft,
    closeDraft,
    startDraft,
    discardDraft,
    pendingAgentBlocks,
    insertAgentBlock,
    consumePendingAgentBlocks,
    sendToComposer,
  }
}
