import { useMemo } from "react"
import type { NotificationLevel, Stream } from "@threahq/types"
import {
  useWorkspaceStreamIndex,
  useWorkspaceStreamMemberships,
  useWorkspaceUnreadState,
  type CachedUnreadState,
} from "@/stores/workspace-store"
import { inheritedNotificationLevel } from "@/sync/muted-streams"

export interface InheritedStreamLevel {
  level: NotificationLevel
  /** The ancestor whose level this stream follows, or null when its type's default applies. */
  fromStreamId: string | null
}

const pickMutedStreamIds = (state: CachedUnreadState) => state.mutedStreamIds

/**
 * What a stream gets with no notification level of its own, from your levels
 * on its ancestors as the workspace caches hold them: the backend's rule. A
 * parent the caches can't resolve defers to the bootstrap's muted set for the
 * stream `id`, which the Inbox reads too.
 */
export function useInheritedNotificationLevel(
  workspaceId: string,
  stream: Pick<Stream, "type" | "parentStreamId"> & { id?: string }
): InheritedStreamLevel {
  const streams = useWorkspaceStreamIndex(workspaceId)
  const memberships = useWorkspaceStreamMemberships(workspaceId)
  const mutedStreamIds = useWorkspaceUnreadState(workspaceId, pickMutedStreamIds)
  const { id, type, parentStreamId } = stream
  return useMemo(() => {
    const levels = new Map(memberships.map((row) => [row.streamId, row.notificationLevel]))
    const { level, from } = inheritedNotificationLevel(
      { id, type, parentStreamId },
      { streams, levels },
      mutedStreamIds ? new Set(mutedStreamIds) : undefined
    )
    return { level, fromStreamId: from?.streamId ?? null }
  }, [id, type, parentStreamId, streams, memberships, mutedStreamIds])
}
