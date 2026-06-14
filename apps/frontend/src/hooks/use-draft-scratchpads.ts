import { useCallback } from "react"
import { db, type DraftScratchpad } from "@/db"
import {
  deleteDraftScratchpadFromCache,
  upsertDraftScratchpadInCache,
  useDraftScratchpadsFromStore,
} from "@/stores/draft-store"
import { purgeScopeDrafts } from "./use-draft-message"
import type { CompanionMode } from "@threa/types"

export function generateDraftId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `draft_${timestamp}${random}`
}

export function isDraftId(id: string): boolean {
  return id.startsWith("draft_")
}

export function useDraftScratchpads(workspaceId: string) {
  const drafts = useDraftScratchpadsFromStore(workspaceId)

  const createDraft = useCallback(
    async (companionMode: CompanionMode = "on"): Promise<string> => {
      const id = generateDraftId()
      const draft: DraftScratchpad = {
        id,
        workspaceId,
        displayName: null,
        companionMode,
        createdAt: Date.now(),
      }
      await db.draftScratchpads.add(draft)
      upsertDraftScratchpadInCache(workspaceId, draft)
      return id
    },
    [workspaceId]
  )

  const updateDraft = useCallback(
    async (
      id: string,
      data: Partial<Pick<DraftScratchpad, "displayName" | "companionMode" | "allowedToolCategories">>
    ) => {
      await db.draftScratchpads.update(id, data)
      const existingDraft = drafts.find((draft) => draft.id === id)
      if (existingDraft) {
        upsertDraftScratchpadInCache(workspaceId, { ...existingDraft, ...data })
      }
    },
    [drafts, workspaceId]
  )

  const deleteDraft = useCallback(
    async (id: string) => {
      await db.draftScratchpads.delete(id)
      deleteDraftScratchpadFromCache(workspaceId, id)
      // Drop the scratchpad scope's drafts (loaded + any stashes) and pointer.
      await purgeScopeDrafts(workspaceId, `stream:${id}`)
    },
    [workspaceId]
  )

  const getDraft = useCallback(
    (id: string): DraftScratchpad | undefined => {
      return drafts?.find((d) => d.id === id)
    },
    [drafts]
  )

  return {
    drafts,
    createDraft,
    updateDraft,
    deleteDraft,
    getDraft,
  }
}
