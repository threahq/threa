import { useMemo, type ComponentType } from "react"
import { Hash, NotebookPen, MessageSquare, Lock, Globe } from "lucide-react"
import type { StreamType } from "@threa/types"
import { useResolvedInAppLink } from "@/components/timeline/in-app-link-preview-card"
import { useStreamName } from "@/hooks/use-stream-name"
import { useWorkspaceStreams } from "@/stores/workspace-store"

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
  const localName = useStreamName(workspaceId, streamId)
  const streams = useWorkspaceStreams(workspaceId)
  const cachedType = useMemo(() => streams.find((s) => s.id === streamId)?.type, [streams, streamId])

  // Only hit the backend when the stream isn't locally named.
  const { data, loading } = useResolvedInAppLink(workspaceId, undefined, localName ? undefined : url, true)

  return useMemo<InAppLinkChipState>(() => {
    if (localName) {
      return { status: "resolved", icon: isMessage ? MessageSquare : streamTypeIcon(cachedType), label: localName }
    }
    if (loading) return { status: "pending" }
    if (data?.accessTier === "cross_workspace") {
      return { status: "restricted", icon: Globe, label: "Another workspace" }
    }
    if (data?.accessTier === "private") {
      return { status: "restricted", icon: Lock, label: "Private conversation" }
    }
    if (data?.kind === "message" && data.deleted) {
      return { status: "restricted", icon: MessageSquare, label: "Deleted message" }
    }
    const name = (data?.kind === "stream" && data.streamName) || (isMessage ? "Message" : "Conversation")
    return { status: "resolved", icon: isMessage ? MessageSquare : Hash, label: name }
  }, [localName, loading, data, cachedType, isMessage])
}
