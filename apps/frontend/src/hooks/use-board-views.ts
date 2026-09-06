import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { BoardView, WorkspaceBootstrap } from "@threahq/types"
import { useBoardViewService, usePreferencesOptional } from "@/contexts"
import { workspaceKeys } from "@/hooks/use-workspaces"
import type { SaveBoardViewInput, UpdateBoardViewInput } from "@/api"

export const boardViewKeys = {
  list: (workspaceId: string) => ["board-views", workspaceId] as const,
}

/**
 * The viewer's saved board lenses. Low-frequency
 * per-viewer config, so it rides React-Query with cache invalidation (the
 * sidebar_configs house style), not the IDB sync engine. `refetchOnReconnect`
 * closes the multi-device gap (INV-53).
 *
 * Seeds from the workspace bootstrap payload (`boardViews`), which carries the
 * saved lenses so the picker paints populated instead of flashing empty for the
 * on-mount fetch. `initialData` only primes an empty cache entry, so a save/
 * update/delete invalidation still refetches; an older bootstrap snapshot lacking
 * the field falls through to the fetch. `initialDataUpdatedAt` inherits the
 * bootstrap's actual fetch time (not the seeded query's mount time), so the 60s
 * `staleTime` counts from when the data was really fetched — otherwise a board
 * opened long after login would read fresh-at-mount and `refetchOnReconnect`
 * (which only fires when stale) couldn't close the multi-device gap (INV-53).
 * Mirrors `useStreamContextBag`.
 */
export function useBoardViews(workspaceId: string) {
  const boardViews = useBoardViewService()
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: boardViewKeys.list(workspaceId),
    queryFn: () => boardViews.list(workspaceId),
    initialData: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))?.boardViews,
    initialDataUpdatedAt: () => queryClient.getQueryState(workspaceKeys.bootstrap(workspaceId))?.dataUpdatedAt,
    staleTime: 60_000,
    refetchOnReconnect: true,
  })
}

export interface BoardHome {
  /** The RESOLVED saved view the viewer homes on — `null` when the home is a plain
   *  lens, the id no longer resolves, or the list is still loading. Drives the pin
   *  fill and the settings radio. */
  view: BoardView | null
}

/**
 * The viewer's board home — the resolved saved view. One resolver for every
 * surface that needs it (the saved-views pin, the lens menu, the settings radio)
 * so they can't drift. `usePreferencesOptional` so it's safe in surfaces mounted
 * without the provider (e.g. the saved-views menu in isolation). The entry-alias
 * redirect in `board.tsx` deliberately keeps its own raw `boardDefaultViewId` +
 * list access — it must tell "still loading" from "unset" to gate the redirect,
 * a distinction the resolved `view` collapses to `null`.
 */
export function useBoardHome(workspaceId: string): BoardHome {
  const preferences = usePreferencesOptional()?.preferences ?? null
  const { data: views } = useBoardViews(workspaceId)
  const configuredId = preferences?.boardDefaultViewId ?? null
  const view = views?.find((v) => v.id === configuredId) ?? null
  return { view }
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
