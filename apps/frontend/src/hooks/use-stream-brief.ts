import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { streamBriefsApi, type StreamBrief } from "@/api"
import { streamKeys } from "./use-streams"

/**
 * Read a stream's brief (roadmap 4.3). `null` means no brief exists yet.
 * Enabled only when a stream is addressed — the settings dialog mounts this,
 * and the dialog itself only renders for stream members.
 */
export function useStreamBrief(workspaceId: string, streamId: string) {
  return useQuery({
    queryKey: streamKeys.brief(workspaceId, streamId),
    queryFn: () => streamBriefsApi.get(workspaceId, streamId),
    enabled: !!workspaceId && !!streamId,
    staleTime: 30_000,
  })
}

/**
 * Full-replacement brief write. The caller passes the version it read; a
 * concurrent edit surfaces as an `ApiError` (`BRIEF_VERSION_CONFLICT`) the
 * caller handles inline (INV-63 — no toast). On success the fresh row lands in
 * the brief cache so the view reflects the new version immediately.
 */
export function useUpdateStreamBrief(workspaceId: string, streamId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { content: string; version: number }) => streamBriefsApi.put(workspaceId, streamId, input),
    onSuccess: (brief) => {
      queryClient.setQueryData<StreamBrief | null>(streamKeys.brief(workspaceId, streamId), brief)
    },
  })
}
