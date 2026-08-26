import { api } from "./client"
import type { BoardView, BoardLens, BoardScopeStreamType } from "@threa/types"

export interface SaveBoardViewInput {
  name: string
  baseLens: BoardLens
  scopeStreamIds: string[]
  scopeStreamTypes: BoardScopeStreamType[]
  scopeLabelIds: string[]
  excludeStreamIds: string[]
  excludeStreamTypes: BoardScopeStreamType[]
  excludeLabelIds: string[]
}

export type UpdateBoardViewInput = Partial<SaveBoardViewInput> & { sortOrder?: number }

/** User-saved board lenses. */
export const boardViewsApi = {
  async list(workspaceId: string): Promise<BoardView[]> {
    const res = await api.get<{ boardViews: BoardView[] }>(`/api/workspaces/${workspaceId}/board/views`)
    return res.boardViews
  },

  async create(workspaceId: string, input: SaveBoardViewInput): Promise<BoardView> {
    const res = await api.post<{ boardView: BoardView }>(`/api/workspaces/${workspaceId}/board/views`, input)
    return res.boardView
  },

  async update(workspaceId: string, boardViewId: string, input: UpdateBoardViewInput): Promise<BoardView> {
    const res = await api.patch<{ boardView: BoardView }>(
      `/api/workspaces/${workspaceId}/board/views/${boardViewId}`,
      input
    )
    return res.boardView
  },

  async remove(workspaceId: string, boardViewId: string): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/board/views/${boardViewId}`)
  },
}
