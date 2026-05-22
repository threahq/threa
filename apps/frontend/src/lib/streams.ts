import { StreamTypes } from "@threa/types"
import type { StreamType } from "@threa/types"
import { Bell, FileText, Hash, MessageSquare } from "lucide-react"
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
}

/** Context-appropriate fallback text for streams that truly have no name yet. */
export function streamFallbackLabel(type: StreamType, context: FallbackContext): string {
  return FALLBACK_LABELS[type]?.[context] ?? "Untitled"
}

interface StreamNameCaches {
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
  if (stream) return getStreamName(stream) ?? streamFallbackLabel(stream.type, context)
  return null
}
