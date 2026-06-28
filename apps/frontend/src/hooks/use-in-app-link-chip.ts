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
 *
 * `prefix` is the channel sigil (`#`): inline (mention-style) surfaces render it
 * as text in front of the bare name, matching a `#channel` mention; the pill
 * surface ignores it and shows the `icon` instead. `label` is always the bare
 * name (no sigil) so neither surface doubles the `#`.
 */
export type InAppLinkChipState =
  | { status: "resolved"; icon: ChipIcon; label: string; prefix?: string }
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
      // A channel renders its `#` as a text prefix (mention-style), so strip it
      // from the bare label; the chip's `prefix` adds it back. Message links keep
      // a message glyph instead of a sigil.
      const isChannelChip = !isMessage && cachedType === "channel"
      const label = isChannelChip && localName.startsWith("#") ? localName.slice(1) : localName
      return {
        status: "resolved",
        icon: isMessage ? MessageSquare : streamTypeIcon(cachedType),
        label,
        prefix: isChannelChip ? "#" : undefined,
      }
    }
    if (loading) return { status: "pending" }
    if (data?.kind === "stream" && data.streamName) {
      const isChannel = data.streamType === "channel"
      return {
        status: "resolved",
        icon: isMessage ? MessageSquare : streamTypeIcon(data.streamType),
        label: data.streamName,
        prefix: !isMessage && isChannel ? "#" : undefined,
      }
    }
    return { status: "resolved", icon: isMessage ? MessageSquare : Hash, label: isMessage ? "Message" : "Conversation" }
  }, [localName, loading, data, cachedType, isMessage])
}
