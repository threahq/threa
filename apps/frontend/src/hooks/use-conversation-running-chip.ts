import { useMemo } from "react"
import type { ActiveAgentSession } from "@threahq/types"
import type { BoardEventRow } from "@/lib/board/board-event-rows"
import { getSessionId } from "@/components/timeline/session-grouping"
import { useAgentSessionActivities } from "@/stores/agent-activity-store"

/**
 * The running agent sessions a conversation surface should light its header chip
 * with. Session ids come from the rows the surface already resolved
 * (conversation-scoped by construction — a sibling conversation's session on the
 * same stream is not among them), live counts from the activity store. Covers a
 * long-running session whose `started` event has scrolled above a card's "N
 * earlier" boundary.
 *
 * Shared by the board card and the conversation panel: the panel is the card's
 * always-expanded peer over the same `eventRows`, so the two must light on the
 * same set or an agent running in an open conversation shows in the feed and
 * vanishes when you open it.
 */
export function useConversationRunningChip(
  workspaceId: string,
  eventRows: readonly BoardEventRow[]
): readonly ActiveAgentSession[] {
  const sessionIds = useMemo(
    () =>
      eventRows.flatMap((row) => {
        if (row.kind !== "session") return []
        const sessionId = row.events.reduce<string | null>((found, event) => found ?? getSessionId(event), null)
        return sessionId ? [sessionId] : []
      }),
    [eventRows]
  )
  return useAgentSessionActivities(workspaceId, sessionIds)
}
