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
  const scratchpads = useDraftScratchpadsFromStore(workspaceId)

  const createScratchpad = useCallback(
    async (companionMode: CompanionMode = "on"): Promise<string> => {
      const id = generateDraftId()
      const scratchpad: DraftScratchpad = {
        id,
        workspaceId,
        displayName: null,
        companionMode,
        createdAt: Date.now(),
      }
      await db.draftScratchpads.add(scratchpad)
      upsertDraftScratchpadInCache(workspaceId, scratchpad)
      return id
    },
    [workspaceId]
  )

  const updateScratchpad = useCallback(
    async (
      id: string,
      data: Partial<Pick<DraftScratchpad, "displayName" | "companionMode" | "allowedToolCategories">>
    ) => {
      await db.draftScratchpads.update(id, data)
      const existing = scratchpads.find((scratchpad) => scratchpad.id === id)
      if (existing) {
        upsertDraftScratchpadInCache(workspaceId, { ...existing, ...data })
      }
    },
    [scratchpads, workspaceId]
  )

  const deleteScratchpad = useCallback(
    async (id: string) => {
      await db.draftScratchpads.delete(id)
      deleteDraftScratchpadFromCache(workspaceId, id)
      // Drop the scratchpad scope's drafts (loaded + any stashes) and pointer.
      await purgeScopeDrafts(workspaceId, `stream:${id}`)
    },
    [workspaceId]
  )

  const getScratchpad = useCallback(
    (id: string): DraftScratchpad | undefined => {
      return scratchpads?.find((s) => s.id === id)
    },
    [scratchpads]
  )

  return {
    scratchpads,
    createScratchpad,
    updateScratchpad,
    deleteScratchpad,
    getScratchpad,
  }
}
