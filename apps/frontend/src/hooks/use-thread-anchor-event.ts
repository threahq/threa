import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useStreamService } from "@/contexts"
import { matchesDeepLinkTarget } from "@/lib/stream-links"
import type { SharedMessageHydration, StreamEvent } from "@threa/types"

export const threadAnchorEventKeys = {
  detail: (workspaceId: string, parentStreamId: string, anchorId: string) =>
    ["thread-anchor-event", workspaceId, parentStreamId, anchorId] as const,
}

interface ThreadAnchorEventResult {
  event: StreamEvent | null
  sharedMessages?: Record<string, SharedMessageHydration>
}

export function useThreadAnchorEvent(
  workspaceId: string,
  parentStreamId: string | null | undefined,
  anchorId: string | null | undefined,
  localEvent: StreamEvent | null | undefined
): ThreadAnchorEventResult {
  const streamService = useStreamService()
  const query = useQuery({
    queryKey: threadAnchorEventKeys.detail(workspaceId, parentStreamId ?? "", anchorId ?? ""),
    queryFn: () => streamService.getEventsAround(workspaceId, parentStreamId!, anchorId!, 2),
    enabled: !!workspaceId && !!parentStreamId && !!anchorId && !localEvent,
    staleTime: Infinity,
  })

  return useMemo(() => {
    if (localEvent) return { event: localEvent }
    const event = query.data?.events.find((candidate) => matchesDeepLinkTarget(candidate, anchorId!)) ?? null
    return { event, sharedMessages: query.data?.sharedMessages }
  }, [anchorId, localEvent, query.data])
}
