import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useSavedSuggestionsService } from "@/contexts"
import { persistSavedRows, savedKeys } from "./use-saved"
import type { SavedSuggestionStatus, SavedSuggestionView } from "@threa/types"

export const savedSuggestionKeys = {
  all: ["saved-suggestions"] as const,
  list: (workspaceId: string, status: SavedSuggestionStatus) => ["saved-suggestions", workspaceId, status] as const,
}

/**
 * The suggested pile — the only suggestion surface the UI shows by default.
 * Pull-only: server-authoritative, refetched on reconnect and when a
 * `saved_suggestion:upserted` socket event invalidates the key.
 */
export function useSuggestedList(workspaceId: string) {
  const service = useSavedSuggestionsService()
  const query = useQuery({
    queryKey: savedSuggestionKeys.list(workspaceId, "suggested"),
    queryFn: () => service.list(workspaceId, { status: "suggested", limit: 50 }),
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    enabled: !!workspaceId,
  })
  return {
    items: query.data?.suggestions ?? [],
    isLoading: query.isLoading,
    nextCursor: query.data?.nextCursor ?? null,
  }
}

/** Live count of pending suggestions, for the Saved tab's "Suggested (n)" affordance. */
export function useSuggestedCount(workspaceId: string): number {
  const { items } = useSuggestedList(workspaceId)
  return items.length
}

export function useAcceptSuggestion(workspaceId: string) {
  const service = useSavedSuggestionsService()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (suggestionId: string) => service.accept(workspaceId, suggestionId),
    onSuccess: (res) => {
      // The accepted suggestion leaves the suggested pile; the new saved item
      // enters the Saved tab. Seed the saved cache so it shows without a round
      // trip, then invalidate both surfaces.
      void persistSavedRows(workspaceId, [res.saved])
      queryClient.invalidateQueries({ queryKey: savedSuggestionKeys.list(workspaceId, "suggested") })
      queryClient.invalidateQueries({ queryKey: savedKeys.list(workspaceId, "saved") })
    },
  })
}

export function useDismissSuggestion(workspaceId: string) {
  const service = useSavedSuggestionsService()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (suggestionId: string) => service.dismiss(workspaceId, suggestionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: savedSuggestionKeys.list(workspaceId, "suggested") })
    },
  })
}

export type { SavedSuggestionView }
