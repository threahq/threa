import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useStreamService } from "@/contexts"
import { matchesDeepLinkTarget } from "@/lib/stream-links"
import { db } from "@/db"
import { writeSlotCarrier } from "@/stores/slot-store"
import type { StreamEvent } from "@threahq/types"

export const threadAnchorEventKeys = {
  detail: (workspaceId: string, parentStreamId: string, anchorId: string) =>
    ["thread-anchor-event", workspaceId, parentStreamId, anchorId] as const,
}

export function useThreadAnchorEvent(
  workspaceId: string,
  parentStreamId: string | null | undefined,
  anchorId: string | null | undefined,
  localEvent: StreamEvent | null | undefined
): { event: StreamEvent | null } {
  const streamService = useStreamService()
  const query = useQuery({
    queryKey: threadAnchorEventKeys.detail(workspaceId, parentStreamId ?? "", anchorId ?? ""),
    queryFn: async () => {
      const result = await streamService.getEventsAround(workspaceId, parentStreamId!, anchorId!, 2)
      // Persist the carrier under the PARENT stream: the anchor event lives there,
      // so its pointer slots belong to the parent's slot map. The parent
      // `useStreamBootstrap` in stream-content writes its own carrier through the
      // normal bootstrap apply (Amendment A2/A3).
      await writeSlotCarrier({
        database: db,
        workspaceId,
        streamId: parentStreamId!,
        carrier: result,
        mode: "merge",
        cachedAt: Date.now(),
      })
      return result
    },
    enabled: !!workspaceId && !!parentStreamId && !!anchorId && !localEvent,
    staleTime: Infinity,
  })

  return useMemo(() => {
    if (localEvent) return { event: localEvent }
    const event = query.data?.events.find((candidate) => matchesDeepLinkTarget(candidate, anchorId!)) ?? null
    return { event }
  }, [anchorId, localEvent, query.data])
}
