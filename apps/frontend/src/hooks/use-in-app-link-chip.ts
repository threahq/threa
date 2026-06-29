import { useMemo, type ComponentType } from "react"
import { Hash, NotebookPen, MessageSquare, Lock, Globe } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"
import type { StreamType, MessageLinkPreviewData } from "@threa/types"
import { db } from "@/db"
import { useResolvedInAppLink } from "@/components/timeline/in-app-link-preview-card"
import { useActors } from "@/hooks/use-actors"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"
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
 * Build a message chip's parts from locally-known data (the cached timeline
 * event + workspace stores), so a link to a message in a stream the viewer can
 * see resolves with no backend round-trip. DM → "{author} to {recipient}" (the
 * other participant — the peer, or the viewer when the viewer authored it);
 * otherwise "{author} in {streamLabel}". `resolveName` maps a user id to its
 * display name (the live actor resolver).
 */
export function buildLocalMessageParts(params: {
  authorId: string
  authorName: string
  streamId: string
  localName: string | null
  dmPeers: ReadonlyArray<{ streamId: string; userId: string }>
  currentUserId: string | null
  resolveName: (userId: string) => string
}): ChipMessageParts {
  const { authorId, authorName, streamId, localName, dmPeers, currentUserId, resolveName } = params
  const dmPeer = dmPeers.find((p) => p.streamId === streamId)
  if (dmPeer) {
    const recipientId = authorId === currentUserId ? dmPeer.userId : currentUserId
    return { lead: authorName, tail: recipientId ? ` to ${resolveName(recipientId)}` : "" }
  }
  return { lead: authorName, tail: localName ? ` in ${localName}` : "" }
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
  messageId,
  isMessage,
  url,
}: {
  workspaceId: string
  streamId: string
  messageId: string | null
  isMessage: boolean
  url: string
}): InAppLinkChipState {
  // Resolve name and type from one set of store reads: `useStreamName` would
  // subscribe to the streams cache internally and the type lookup would scan it
  // again, so go through the pure `resolveStreamName` over the shared array.
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const currentUserId = useCurrentWorkspaceUserId(workspaceId)
  const actors = useActors(workspaceId)
  const localName = useMemo(
    () => resolveStreamName(streamId, { streams, users, dmPeers }),
    [streamId, streams, users, dmPeers]
  )
  const cachedType = useMemo(() => streams.find((s) => s.id === streamId)?.type, [streams, streamId])

  // Message links resolve local-first: the target message is almost always
  // already in the timeline cache (it's a message in a stream the viewer can
  // see), so its author and context resolve with no round-trip and stay behind
  // the same coordinated-loading gate as the rest of the surface. `undefined`
  // means the IDB read is still in flight; `null` is a genuine miss (a message
  // in another stream / not synced) that falls back to the backend resolve.
  const cachedMessageEvent = useLiveQuery(
    async () => {
      if (!isMessage || !streamId || !messageId) return null
      const event = await db.events
        .where("[streamId+eventType]")
        .equals([streamId, "message_created"])
        .filter((e) => (e.payload as { messageId?: string } | null)?.messageId === messageId)
        .first()
      return event ?? null
    },
    [isMessage, streamId, messageId],
    undefined
  )

  // Hit the access-tiered backend resolve only when the target isn't already
  // local: a message that isn't cached here, or an uncached stream link.
  const needsResolve = isMessage ? cachedMessageEvent === null : !localName
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

    // A message reads as "{author} in #channel" / "{author} to {peer}", with the
    // author's live avatar leading the chip.
    if (isMessage) {
      // A delete is a patch-style event that stamps `deletedAt` onto the cached
      // create row (see stream-sync `handleMessageDeleted`), so the tombstone is
      // local too — gate on it before the live chip, matching the backend
      // `data.deleted` branch above, so a cached-then-deleted message never
      // renders as a normal, navigable chip.
      if ((cachedMessageEvent?.payload as { deletedAt?: string } | null)?.deletedAt) {
        return { status: "restricted", icon: MessageSquare, label: "Deleted message" }
      }

      // 1) Local-first: name the author + context straight from the cached
      //    timeline event. A locally-cached message is by definition one the
      //    viewer can read, so no access tier or round-trip is needed.
      const authorId = cachedMessageEvent?.actorId
      if (authorId) {
        const authorType = cachedMessageEvent.actorType ?? "user"
        const dmPeer = dmPeers.find((p) => p.streamId === streamId)
        const isDmStream = cachedType === "dm" || Boolean(dmPeer)
        // A DM chip names the other participant (viewer id + peer row). Until both
        // load, stay pending — which renders the baked label, not a skeleton — so
        // a half-resolved "author only" / "… in {peer}" label never flashes. No
        // wedge: a permanently-missing peer just keeps showing the baked label.
        if (isDmStream && (currentUserId === null || !dmPeer)) {
          return { status: "pending" }
        }
        const lead = actors.getActorName(authorId, authorType)
        const parts = buildLocalMessageParts({
          authorId,
          authorName: lead,
          streamId,
          localName,
          dmPeers,
          currentUserId,
          resolveName: (id) => actors.getActorName(id, "user"),
        })
        const avatar = { url: actors.getActorAvatar(authorId, authorType).avatarUrl, name: lead }
        return {
          status: "resolved",
          icon: MessageSquare,
          label: `${parts.lead}${parts.tail}`,
          avatar,
          messageParts: parts,
        }
      }

      // 2) Backend fallback (message not in the local cache).
      if (data?.kind === "message" && data.accessTier === "full") {
        const parts = buildMessageChipParts(data)
        if (parts) {
          // Prefer the author's live avatar from the workspace store; fall back to
          // the resolve's point-in-time snapshot for an author not cached locally.
          const liveAvatarUrl = data.authorId
            ? actors.getActorAvatar(data.authorId, data.authorType ?? "user").avatarUrl
            : undefined
          const avatarUrl = liveAvatarUrl ?? data.authorAvatarUrl
          const avatar = data.authorName ? { url: avatarUrl, name: data.authorName } : undefined
          return {
            status: "resolved",
            icon: MessageSquare,
            label: `${parts.lead}${parts.tail}`,
            avatar,
            messageParts: parts,
          }
        }
        // Fully resolved but the author can't be named — settle on the generic
        // word, not the cached parent-stream name (a stream label would mislabel
        // the message node InAppLinkView serializes into attrs.name).
        return { status: "resolved", icon: MessageSquare, label: "Message" }
      }
      if (cachedMessageEvent === undefined || loading) return { status: "pending" }
      return { status: "resolved", icon: MessageSquare, label: "Message" }
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
  }, [
    localName,
    loading,
    data,
    cachedType,
    isMessage,
    cachedMessageEvent,
    actors,
    dmPeers,
    streamId,
    currentUserId,
  ])
}
