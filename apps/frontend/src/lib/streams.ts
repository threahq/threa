import { SLUG_MAX_LENGTH, StreamTypes } from "@threa/types"
import type { StreamType } from "@threa/types"
import { Bell, FileText, Hash, MessageSquare, MessageSquareDashed, NotebookPen } from "lucide-react"
import type { ComponentType } from "react"

/**
 * Canonical icon for each stream type. Shared by the quick-switcher list
 * and the share-message picker so the visual vocabulary doesn't drift
 * between two surfaces that ultimately list the same streams.
 */
export const STREAM_ICONS: Record<StreamType, ComponentType<{ className?: string }>> = {
  [StreamTypes.SCRATCHPAD]: FileText,
  [StreamTypes.CHANNEL]: Hash,
  [StreamTypes.DM]: MessageSquare,
  [StreamTypes.THREAD]: MessageSquare,
  [StreamTypes.SYSTEM]: Bell,
  [StreamTypes.ASIDE]: MessageSquareDashed,
}

/**
 * A system-purpose stream (e.g. the persona editor's test scratchpad) is fully
 * functional when mounted directly but must not appear in user-facing stream
 * LISTS (sidebar, quick switcher). Multiple code paths legitimately persist
 * such a stream to IDB (any detail fetch does), so listing surfaces filter at
 * read time with this predicate rather than every writer guarding — and name
 * resolution (`useStreamName`) stays unfiltered so labels still resolve.
 */
export function isUtilityStream(stream: { purpose?: string | null }): boolean {
  return stream.purpose != null
}

/**
 * A stream type that never lists by itself: an aside is reachable only through
 * its anchor row in the host stream (and the command palette, own asides only).
 * The sidebar, the unread badge, the last-location landing and the stream
 * pickers all apply this one predicate instead of each knowing the type — an
 * unhandled aside would otherwise inherit scratchpad listing and light the
 * badge on every agent reply, against its decided silent attention.
 */
export function isHiddenStreamType(stream: { type: string }): boolean {
  return stream.type === StreamTypes.ASIDE
}

/**
 * The ids that never list, out of a workspace's cached streams: every hidden
 * stream and every stream rooted in one (a thread opened inside an aside is a
 * `thread` row whose root is the aside). For the surfaces that aggregate over
 * all streams — the tab badge, the last-location landing, label lists — where
 * a row's own type is not enough to tell.
 */
export function hiddenStreamIds(
  streams: readonly { id: string; type: string; rootStreamId?: string | null }[]
): Set<string> {
  const hidden = new Set<string>()
  for (const stream of streams) if (isHiddenStreamType(stream)) hidden.add(stream.id)
  for (const stream of streams) if (stream.rootStreamId && hidden.has(stream.rootStreamId)) hidden.add(stream.id)
  return hidden
}

/** Human-readable label for a stream type ("Scratchpad", "Channel", …). */
export function getStreamTypeLabel(type: StreamType): string {
  switch (type) {
    case StreamTypes.SCRATCHPAD:
      return "Scratchpad"
    case StreamTypes.CHANNEL:
      return "Channel"
    case StreamTypes.DM:
      return "DM"
    case StreamTypes.THREAD:
      return "Thread"
    case StreamTypes.ASIDE:
      return "Aside"
    default:
      return type
  }
}

/**
 * Returns the resolved display name for a stream, or null if the stream
 * has no name yet (draft scratchpad, new thread, etc.).
 *
 * Channels use their slug prefixed with #.
 * DMs should arrive from bootstrap with displayName pre-resolved to participant names.
 * Threads/scratchpads use their AI-generated displayName or null for drafts.
 */
export function getStreamName(stream: {
  type: string
  slug?: string | null
  displayName?: string | null
}): string | null {
  if (stream.type === StreamTypes.CHANNEL) return stream.slug ? `#${stream.slug}` : null
  return stream.displayName ?? null
}

/**
 * Resolves the display name for a DM stream from local workspace caches.
 *
 * DM display names are viewer-specific and only computed on the backend at
 * bootstrap time. Socket events (`stream:created`, `stream:updated`) carry the
 * raw DB row with `displayName: null`, which can overwrite IDB state before a
 * bootstrap refetch lands. Resolving from the peer user via `dmPeers` +
 * `workspaceUsers` keeps the UI correct regardless of what the cached
 * `stream.displayName` happens to contain.
 *
 * Returns null when the peer user cannot be resolved yet (caller should fall
 * back to whatever name it already has).
 */
export function resolveDmDisplayName(
  streamId: string,
  workspaceUsers: Array<{ id: string; name: string }>,
  dmPeers: Array<{ streamId: string; userId: string }>
): string | null {
  const peerUserId = dmPeers.find((peer) => peer.streamId === streamId)?.userId
  if (!peerUserId) return null
  return workspaceUsers.find((u) => u.id === peerUserId)?.name ?? null
}

export type FallbackContext = "sidebar" | "activity" | "breadcrumb" | "generic" | "noun"

const FALLBACK_LABELS: Record<string, Record<FallbackContext, string>> = {
  scratchpad: {
    sidebar: "New scratchpad",
    activity: "a scratchpad",
    breadcrumb: "Untitled",
    generic: "Untitled",
    noun: "scratchpad",
  },
  thread: { sidebar: "New thread", activity: "a thread", breadcrumb: "Thread", generic: "Thread", noun: "thread" },
  channel: { sidebar: "Untitled", activity: "a channel", breadcrumb: "...", generic: "Untitled", noun: "channel" },
  dm: { sidebar: "Direct message", activity: "a conversation", breadcrumb: "DM", generic: "DM", noun: "DM" },
  system: { sidebar: "System", activity: "system", breadcrumb: "System", generic: "System", noun: "system stream" },
  aside: { sidebar: "New aside", activity: "an aside", breadcrumb: "Aside", generic: "Aside", noun: "aside" },
}

/** Context-appropriate fallback text for streams that truly have no name yet. */
export function streamFallbackLabel(type: StreamType, context: FallbackContext): string {
  return FALLBACK_LABELS[type]?.[context] ?? "Untitled"
}

/**
 * The display label for a stream object — always a non-null string. Resolves
 * the name (channel slug / displayName) and falls through to a context-
 * appropriate placeholder when the stream has no name yet.
 *
 * This is the entry point for any surface that renders a stream's name and
 * needs a guaranteed string. Use the nullable `getStreamName` only when you
 * genuinely need null (sort/search keys, or a bespoke caller-specific
 * fallback). For DM objects whose `displayName` may be stale, resolve the peer
 * first (or go through `resolveStreamName`/`useStreamName` by id).
 */
export function streamLabel(
  stream: { type: string; slug?: string | null; displayName?: string | null },
  context: FallbackContext = "generic"
): string {
  return getStreamName(stream) ?? streamFallbackLabel(stream.type as StreamType, context)
}

export interface StreamNameCaches {
  streams: Array<{ id: string; type: StreamType; slug?: string | null; displayName?: string | null }>
  users: Array<{ id: string; name: string }>
  dmPeers: Array<{ streamId: string; userId: string }>
}

/**
 * Resolve a stream's display name from the workspace caches by id — the single
 * entry point any surface should use when it has a stream id and wants a label.
 *
 * DMs resolve from the peer user first, which works even when the DM's stream
 * object isn't in the streams cache (`dmPeers` covers every DM the viewer
 * belongs to). Other types use the cached stream's name with a context
 * fallback. Returns null only when the id matches no DM peer and no cached
 * stream, so the caller can layer its own last-resort fallback (e.g. a
 * persisted snapshot name).
 *
 * Prefer the `useStreamName` hook in components; this pure function exists for
 * non-hook contexts (list mappers, tests) and as the hook's implementation.
 */
export function resolveStreamName(
  streamId: string,
  caches: StreamNameCaches,
  context: FallbackContext = "generic"
): string | null {
  const peerName = resolveDmDisplayName(streamId, caches.users, caches.dmPeers)
  if (peerName) return peerName
  const stream = caches.streams.find((s) => s.id === streamId)
  if (stream) return streamLabel(stream, context)
  return null
}

/**
 * The stream types a `#` link can point at: the workspace's named, linkable
 * rooms. One list, because the composer's suggestion source and the renderer's
 * id→url/label map have to agree — a type offered by one and not resolved by
 * the other inserts a chip that renders as dead plain text.
 */
export const LINKABLE_STREAM_TYPES: readonly StreamType[] = [StreamTypes.CHANNEL, StreamTypes.SCRATCHPAD]

export interface StreamChipParts {
  icon: ComponentType<{ className?: string }>
  /** The bare name, never carrying the sigil — no surface doubles the `#`. */
  label: string
  /** The channel sigil, rendered as text ahead of the label. Channels only. */
  prefix?: string
}

/**
 * How a stream reads inside an inline chip — the `#` mention and the in-app
 * stream link render the identical shape, in the composer and the timeline
 * alike. A channel carries its sigil as `prefix` so it reads as a mention;
 * every other type leads with `icon`.
 *
 * The scratchpad glyph is deliberately not {@link STREAM_ICONS}': a chip sits in
 * a line of prose, where the note glyph reads as a written page, while the
 * sidebar and pickers keep the flatter document mark across a whole list.
 */
export function streamChipParts(type: StreamType | undefined, name: string): StreamChipParts {
  if (type === StreamTypes.CHANNEL) return { icon: Hash, label: name.replace(/^#/, ""), prefix: "#" }
  return { icon: type === StreamTypes.SCRATCHPAD ? NotebookPen : MessageSquare, label: name }
}

/** Whether a `#` chip may point at this stream type ({@link LINKABLE_STREAM_TYPES}). */
export function isLinkableStreamType(type: string): boolean {
  return LINKABLE_STREAM_TYPES.includes(type as StreamType)
}

/**
 * Label for a `#` chip pointing at `stream`. Channels carry a slug; scratchpads
 * never do (`createScratchpad` mints none), so their display name is folded into
 * slug shape. The chip's `attrs.id` is the authoritative reference (INV-64) and
 * this is display only, so a fold collision between two same-named pads is
 * harmless.
 */
export function streamChipSlug(stream: { type: string; slug?: string | null; displayName?: string | null }): string {
  if (stream.slug) return stream.slug
  const folded = streamLabel(stream, "generic")
    .toLowerCase()
    // Letters and digits in any script (INV-54): folding to ASCII would empty
    // out a name written in one, and the chip would read `#scratchpad`.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, "")
  return folded || streamFallbackLabel(stream.type as StreamType, "noun")
}
