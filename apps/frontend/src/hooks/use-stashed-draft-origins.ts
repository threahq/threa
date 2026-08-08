import { useMemo } from "react"
import { conversationOriginLabel, subtopicOriginLabel, threadOriginLabel } from "@/lib/drafts/origin-label"
import { resolveStreamName, streamFallbackLabel } from "@/lib/streams"
import { useWorkspaceDmPeers, useWorkspaceStreams, useWorkspaceUsers } from "@/stores/workspace-store"
import type { StashedDraftOrigin } from "./use-stashed-drafts"

/** What the picker renders per row: which tier it is in, and where it came from. */
export interface StashedDraftRowOrigin {
  tier: "own" | "borrowed"
  /** Always a displayable string — an unresolved place degrades to the explorer's wording. */
  label: string
  /** Another scope's composer holds this draft; a tap takes it over (quiet hint, never a gate). */
  checkedOutElsewhere: boolean
  /** Set when the row NAVIGATES (branch reply / mounted composer) instead of restoring here. */
  openHref: string | null
  /** The destination conversation for the arrival focus signal; set with `openHref`. */
  openConversationId: string | null
  /** False for the manual-pickup fallback: the destination shows the conversation but not the draft. */
  openCarriesDraft: boolean
}

/**
 * Turns the pile's structured origins into row labels. The picker stays
 * presentational (INV-15): it receives `{ tier, label }` and never resolves a
 * stream, a conversation or a scope string itself.
 *
 * Stream names go through `lib/streams` (INV-35 / frontend CLAUDE.md) so DM
 * peers resolve the same way they do everywhere else; conversation topics ride
 * in on the origin, already read from the cached board post.
 */
export function useStashedDraftOrigins(
  workspaceId: string,
  originByDraftId: Map<string, StashedDraftOrigin>
): Map<string, StashedDraftRowOrigin> {
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)

  return useMemo(() => {
    const caches = { streams, users, dmPeers }
    const streamName = (streamId: string) => resolveStreamName(streamId, caches, "sidebar")
    const label = (origin: StashedDraftOrigin): string => {
      switch (origin.kind) {
        case "stream":
          return streamName(origin.streamId) ?? streamFallbackLabel("channel", "sidebar")
        case "thread":
          return threadOriginLabel(origin.streamId ? streamName(origin.streamId) : null)
        case "conversation":
        case "branch":
          // Same ladder the drafts explorer climbs — topic, else the anchor
          // stream's name, else the generic phrase. Skipping the middle rung
          // made the picker say "Conversation reply" for every conversation the
          // extractor had not titled yet, while the explorer said "Reply in
          // #general" for the same row.
          return conversationOriginLabel(
            origin.title ?? (origin.anchorStreamId ? streamName(origin.anchorStreamId) : null)
          )
        case "subtopic":
          return subtopicOriginLabel(origin.title ?? streamName(origin.streamId))
      }
    }
    const map = new Map<string, StashedDraftRowOrigin>()
    for (const [draftId, origin] of originByDraftId) {
      map.set(draftId, {
        tier: origin.tier,
        label: label(origin),
        checkedOutElsewhere: origin.checkedOutElsewhere,
        openHref: origin.openHref,
        openConversationId: origin.openConversationId,
        openCarriesDraft: origin.openCarriesDraft,
      })
    }
    return map
  }, [originByDraftId, streams, users, dmPeers])
}
