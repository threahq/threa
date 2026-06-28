import { useMemo, type ComponentType } from "react"
import { Hash, NotebookPen, MessageSquare, Lock, Globe } from "lucide-react"
import type { StreamType } from "@threa/types"
import { useResolvedInAppLink } from "@/components/timeline/in-app-link-preview-card"
import { resolveStreamName } from "@/lib/streams"
import { useWorkspaceStreams, useWorkspaceUsers, useWorkspaceDmPeers } from "@/stores/workspace-store"

type ChipIcon = ComponentType<{ className?: string }>

/**
 * Resolved state for an in-app stream/message chip. `resolved` carries a real
 * name (local cache or full-access backend resolve); `restricted` is a tiered
 * placeholder the viewer can't see past (cross-workspace / private / deleted);
 * `pending` means the backend resolve is in flight and the caller should fall
 * back to its cached label rather than flashing a placeholder (INV-21).
 */
export type InAppLinkChipState =
  | { status: "resolved"; icon: ChipIcon; label: string }
  | { status: "restricted"; icon: ChipIcon; label: string }
  | { status: "pending" }

function streamTypeIcon(streamType: StreamType | undefined): ChipIcon {
  switch (streamType) {
    case "scratchpad":
      return NotebookPen
    case "channel":
      return Hash
    default:
      return MessageSquare
  }
}

/**
 * Resolve a stream/message in-app link to a chip icon + label. Local workspace
 * cache first (the canonical name source — handles channels, scratchpads, DM
 * peers, decrypted E2E names, and any stream the viewer can see without a
 * round-trip); the access-tiered backend resolve is the fallback only when the
 * stream isn't cached (no access / cross-workspace / thread). Shared by the
 * composer chip, the editor node-view, and the timeline renderer so all three
 * name an in-app link the same way.
 */
export function useInAppLinkChip({
  workspaceId,
  streamId,
  isMessage,
  url,
}: {
  workspaceId: string
  streamId: string
  isMessage: boolean
  url: string
}): InAppLinkChipState {
  // Resolve name and type from one set of store reads: `useStreamName` would
  // subscribe to the streams cache internally and the type lookup would scan it
  // again, so go through the pure `resolveStreamName` over the shared array.
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const localName = useMemo(
    () => resolveStreamName(streamId, { streams, users, dmPeers }),
    [streamId, streams, users, dmPeers]
  )
  const cachedType = useMemo(() => streams.find((s) => s.id === streamId)?.type, [streams, streamId])

  // A local name covers a stream link outright, but a message link still needs
  // the backend resolve to learn the message is deleted/restricted — the local
  // cache only names the parent stream. So message links always resolve; stream
  // links resolve only when uncached.
  const needsResolve = isMessage || !localName
  const { data, loading } = useResolvedInAppLink(workspaceId, undefined, needsResolve ? url : undefined, true)

  return useMemo<InAppLinkChipState>(() => {
    // Restricted/deleted tiers (backend) win over the cached name so a deleted
    // or out-of-reach target never renders as a normal, navigable chip.
    if (data?.accessTier === "cross_workspace") {
      return { status: "restricted", icon: Globe, label: "Another workspace" }
    }
    if (data?.accessTier === "private") {
      return { status: "restricted", icon: Lock, label: "Private conversation" }
    }
    if (data?.kind === "message" && data.deleted) {
      return { status: "restricted", icon: MessageSquare, label: "Deleted message" }
    }
    if (localName) {
      // A channel's resolved name is already `#slug`, and a channel stream chip
      // renders the Hash icon too — strip the slug's leading `#` so it doesn't
      // double up as "# #channel". Message chips keep it (their icon is a
      // message glyph, so the `#` still reads as "in #channel").
      const isChannelChip = !isMessage && cachedType === "channel"
      const label = isChannelChip && localName.startsWith("#") ? localName.slice(1) : localName
      return { status: "resolved", icon: isMessage ? MessageSquare : streamTypeIcon(cachedType), label }
    }
    if (loading) return { status: "pending" }
    const name = (data?.kind === "stream" && data.streamName) || (isMessage ? "Message" : "Conversation")
    return { status: "resolved", icon: isMessage ? MessageSquare : Hash, label: name }
  }, [localName, loading, data, cachedType, isMessage])
}
