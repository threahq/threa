import { useMemo, type ComponentType } from "react"
import { Hash, NotebookPen, MessageSquare, Lock, Globe } from "lucide-react"
import { getAvatarUrl, type StreamType, type MessageLinkPreviewData } from "@threa/types"
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
  | {
      status: "resolved"
      icon: ChipIcon
      label: string
      prefix?: string
      avatar?: ChipAvatar
      messageParts?: ChipMessageParts
    }
  | { status: "restricted"; icon: ChipIcon; label: string }
  | { status: "pending" }

/**
 * Leading author face for a message chip — the avatar image when the author has
 * one, with `name` driving the alt text and the initial fallback. Absent for
 * stream chips and unnamed (bot/persona) authors, which keep their type glyph.
 */
export interface ChipAvatar {
  url?: string
  name: string
}

/**
 * A message chip split into the author (`lead`) and the location suffix
 * (`tail`, e.g. " in #channel" / " to Pierre"). The chip truncates `lead` and
 * pins `tail`, so the destination — the part that disambiguates two messages by
 * the same author — survives truncation. `label` joins them for serialization.
 */
export interface ChipMessageParts {
  lead: string
  tail: string
}

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
 * Split a resolved message link into author (`lead`) and location (`tail`) the
 * way the surrounding chat reads it: " to {recipient}" for a DM, " in #channel"
 * or " in {name}" otherwise. Full names on both sides (no viewer-relative "You"),
 * so the label is identical for every reader — it's also what gets serialized
 * back into the link's markdown. Returns null when the author couldn't be
 * resolved (e.g. a bot/persona author the backend doesn't name yet); the caller
 * then settles the fully-resolved chip on the generic "Message".
 */
export function buildMessageChipParts(data: MessageLinkPreviewData): ChipMessageParts | null {
  const lead = data.authorName
  if (!lead) return null
  if (data.streamType === "dm") {
    return { lead, tail: data.recipientName ? ` to ${data.recipientName}` : "" }
  }
  if (data.streamName) {
    const name = data.streamType === "channel" ? `#${data.streamName.replace(/^#/, "")}` : data.streamName
    return { lead, tail: ` in ${name}` }
  }
  return { lead, tail: "" }
}

/** The joined message label, for serialization and the pending fallback. */
export function buildMessageChipLabel(data: MessageLinkPreviewData): string | null {
  const parts = buildMessageChipParts(data)
  return parts ? `${parts.lead}${parts.tail}` : null
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

    // A message reads as "{author} in #channel" / "{author} to {peer}" — that
    // rich backend label is the whole point, so it wins over the cached
    // parent-stream name; the parent name (or a generic word) is only a fallback
    // while the resolve is in flight or the author couldn't be named.
    if (isMessage) {
      if (data?.kind === "message" && data.accessTier === "full") {
        const parts = buildMessageChipParts(data)
        if (parts) {
          const label = `${parts.lead}${parts.tail}`
          // Prefer the author's live avatar from the workspace store (reactive to
          // avatar changes, like the rest of the app); fall back to the resolve's
          // point-in-time snapshot for an author not in the local cache.
          const liveUser =
            data.authorType === "user" && data.authorId ? users.find((u) => u.id === data.authorId) : undefined
          const avatarUrl = liveUser
            ? (getAvatarUrl(workspaceId, liveUser.avatarUrl, 64) ?? undefined)
            : data.authorAvatarUrl
          const avatar = data.authorName ? { url: avatarUrl, name: data.authorName } : undefined
          return { status: "resolved", icon: MessageSquare, label, avatar, messageParts: parts }
        }
        // Fully resolved but the author can't be named (bot/persona) — settle on
        // the generic word, not the cached parent-stream name. The parent name is
        // a stream label; stamping it onto a message node (InAppLinkView writes
        // the resolved label into attrs.name) would mislabel the link.
        return { status: "resolved", icon: MessageSquare, label: "Message" }
      }
      if (loading) return { status: "pending" }
      return { status: "resolved", icon: MessageSquare, label: localName ?? "Message" }
    }

    // Stream links: a channel renders its `#` as a text prefix (mention-style),
    // so strip it from the bare label and let the chip's `prefix` add it back.
    if (localName) {
      const isChannelChip = cachedType === "channel"
      const label = isChannelChip && localName.startsWith("#") ? localName.slice(1) : localName
      return { status: "resolved", icon: streamTypeIcon(cachedType), label, prefix: isChannelChip ? "#" : undefined }
    }
    if (loading) return { status: "pending" }
    if (data?.kind === "stream" && data.streamName) {
      const isChannel = data.streamType === "channel"
      return {
        status: "resolved",
        icon: streamTypeIcon(data.streamType),
        label: data.streamName,
        prefix: isChannel ? "#" : undefined,
      }
    }
    return { status: "resolved", icon: Hash, label: "Conversation" }
  }, [localName, loading, data, cachedType, isMessage, users, workspaceId])
}
