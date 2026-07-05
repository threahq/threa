import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useBoardViewService } from "@/contexts"
import type { SaveBoardViewInput, UpdateBoardViewInput } from "@/api"

export const boardViewKeys = {
  list: (workspaceId: string) => ["board-views", workspaceId] as const,
}

/**
 * The viewer's saved board lenses (board-view-design.md § "Lenses"). Low-frequency
 * per-viewer config, so it rides React-Query with cache invalidation (the
 * sidebar_configs house style), not the IDB sync engine. `refetchOnReconnect`
 * closes the multi-device gap (INV-53).
 */
export function useBoardViews(workspaceId: string) {
  const boardViews = useBoardViewService()
  return useQuery({
    queryKey: boardViewKeys.list(workspaceId),
    queryFn: () => boardViews.list(workspaceId),
    staleTime: 60_000,
    refetchOnReconnect: true,
  })
}

/**
 * Save the board's current filter state as a named view. Success is silent — the
 * picker gains the new entry (INV-63); only failures toast.
 */
export function useSaveBoardView(workspaceId: string) {
  const boardViews = useBoardViewService()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SaveBoardViewInput) => boardViews.create(workspaceId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardViewKeys.list(workspaceId) }),
    onError: () => toast.error("Couldn't save the view"),
  })
}

export function useUpdateBoardView(workspaceId: string) {
  const boardViews = useBoardViewService()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateBoardViewInput }) =>
      boardViews.update(workspaceId, id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardViewKeys.list(workspaceId) }),
    onError: () => toast.error("Couldn't update the view"),
  })
}

export function useDeleteBoardView(workspaceId: string) {
  const boardViews = useBoardViewService()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => boardViews.remove(workspaceId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardViewKeys.list(workspaceId) }),
    onError: () => toast.error("Couldn't delete the view"),
  })
}
