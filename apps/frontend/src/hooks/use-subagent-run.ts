import { useQuery } from "@tanstack/react-query"
import { subagentsApi } from "@/api"

export const subagentKeys = {
  all: ["subagents"] as const,
  /** One run by id — the invalidation target when a subagent socket event lands (stream-sync). */
  run: (workspaceId: string, subagentId: string) => [...subagentKeys.all, "run", workspaceId, subagentId] as const,
}

/**
 * The authoritative run, for the one thing the timeline cannot answer: a thread
 * opened by deep link, whose parent stream is not cached, so the run's status
 * patches are nowhere in reach. Without it a finished run reads as open and every
 * message posted after it closed carries the delegated-model badge.
 *
 * Gated by `enabled` at the call site — the loaded-window path costs no fetch and
 * must keep costing none. stream-sync invalidates this key on both subagent
 * socket events (INV-53), so a run that settles while the thread is open updates.
 */
export function useSubagentRun(workspaceId: string, subagentId: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: subagentKeys.run(workspaceId, subagentId ?? ""),
    queryFn: () => subagentsApi.get(workspaceId, subagentId!),
    enabled: !!workspaceId && !!subagentId && (options?.enabled ?? true),
    staleTime: 30_000,
  })
}
