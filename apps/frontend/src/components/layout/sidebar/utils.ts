import { serializeToMarkdown } from "@threa/prosemirror"
import {
  AuthorTypes,
  StreamTypes,
  Visibilities,
  type AuthorType,
  type JSONContent,
  type StreamWithPreview,
} from "@threa/types"
import { createDmDraftId } from "@/hooks/use-stream-or-draft"
import { stripMarkdownToInline } from "@/lib/markdown"
import { getStreamName } from "@/lib/streams"
import type { SectionKey, SortType, StreamItemData, UrgencyLevel } from "./types"

/** Minimal workspace-user shape needed to synthesize a DM draft row. */
interface VirtualDmUser {
  id: string
  name: string
}

/**
 * Synthesize "virtual DM draft" rows for workspace members the viewer has no DM
 * stream with yet. Returns `[]` in board mode: a nonexistent DM has no
 * conversations, so the row would be dead weight on the board
 * (board-centered-sidebar-exploration.md § "Feature parity").
 */
export function buildVirtualDmDrafts(args: {
  isBoardMode: boolean
  workspaceId: string
  currentUserId: string | null
  workspaceUsers: readonly VirtualDmUser[]
  dmPeerUserIds: readonly string[]
}): StreamItemData[] {
  const { isBoardMode, workspaceId, currentUserId, workspaceUsers, dmPeerUserIds } = args
  if (isBoardMode) return []
  if (workspaceUsers.length === 0 || !currentUserId) return []

  const dmPeerIds = new Set(dmPeerUserIds)
  const now = new Date().toISOString()

  return workspaceUsers
    .filter((workspaceUser) => workspaceUser.id !== currentUserId)
    .filter((workspaceUser) => !dmPeerIds.has(workspaceUser.id))
    .map(
      (workspaceUser): StreamItemData => ({
        id: createDmDraftId(workspaceUser.id),
        workspaceId,
        type: StreamTypes.DM,
        displayName: workspaceUser.name,
        slug: null,
        description: null,
        visibility: Visibilities.PRIVATE,
        parentStreamId: null,
        parentMessageId: null,
        rootStreamId: null,
        companionMode: "off",
        companionPersonaId: null,
        createdBy: currentUserId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        lastMessagePreview: null,
        urgency: "quiet",
        section: "other",
        dmPeerUserId: workspaceUser.id,
      })
    )
    .sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""))
}

/** Minimal stream shape for the sidebar visibility filter. */
interface SidebarVisibilityStream {
  id: string
  archivedAt: string | null
  rootStreamId: string | null
  visibility: string
}

/**
 * Whether a stream should appear in the sidebar. A stream is hidden when it is
 * archived, or when it is a thread whose root stream is archived — archiving
 * marks only the root row, so without the root check every nested thread under
 * an archived scratchpad/channel would still surface. Non-public streams are
 * always visible (bootstrap only includes them when the viewer has access);
 * public ones require explicit membership.
 */
export function isSidebarStreamVisible(
  stream: SidebarVisibilityStream,
  memberStreamIds: ReadonlySet<string>,
  archivedStreamIds: ReadonlySet<string>
): boolean {
  if (stream.archivedAt) return false
  if (stream.rootStreamId && archivedStreamIds.has(stream.rootStreamId)) return false
  if (stream.visibility !== Visibilities.PUBLIC) return true
  return memberStreamIds.has(stream.id)
}

/** Minimal stream shape needed for urgency calculation */
interface StreamWithOptionalPreview {
  lastMessagePreview?: { authorType: AuthorType } | null
}

/** Calculate urgency level for a stream based on unread, mention, and activity state */
export function calculateUrgency(
  stream: StreamWithOptionalPreview,
  unreadCount: number,
  mentionCount: number,
  isMuted: boolean,
  activityCount = 0
): UrgencyLevel {
  if (isMuted) return "quiet"

  if (mentionCount > 0) return "mentions"

  // Unread messages or unread activity both light the row; color either case by
  // the last author so a persona reads gold, a bot green, a human (or unknown)
  // blue. activityCount counts on its own because a notification can reach the
  // always-joined per-user room (activity:created) before the per-stream
  // stream:activity that drives unreadCount — e.g. before the stream-room join
  // lands, or while briefly disconnected — so the row never stays quiet for
  // something the Activity feed is already showing.
  if (unreadCount > 0 || activityCount > 0) {
    const authorType = stream.lastMessagePreview?.authorType
    if (authorType === AuthorTypes.PERSONA) return "ai"
    if (authorType === AuthorTypes.BOT) return "bot"
    return "activity"
  }

  return "quiet"
}

/**
 * Whether a stream counts as unread for the dedicated Unread section: it has
 * unread messages and isn't muted. A muted stream reads as "quiet" urgency even
 * with unread messages (see {@link calculateUrgency}) and must not resurface —
 * the same rule {@link categorizeStream} uses to keep muted unreads out of Recent.
 */
export function isUnreadStream(stream: { urgency: UrgencyLevel }, unreadCount: number): boolean {
  return unreadCount > 0 && stream.urgency !== "quiet"
}

/** Categorize stream into smart section */
export function categorizeStream(
  stream: StreamWithPreview,
  unreadCount: number,
  urgency: UrgencyLevel,
  activityCount = 0
): SectionKey {
  if (urgency === "mentions" || (urgency === "ai" && unreadCount > 0)) {
    return "important"
  }

  // A stream the user is still catching up on stays in Recent regardless of age
  // or whether a preview has been cached yet — it should never sink into
  // "Everything else". This covers unread messages and activity-only streams. The
  // activity signal is read from activityCount, not urgency: an activity-only row
  // now carries its actor's color (gold/green/blue), so urgency no longer spells
  // "activity". Muted streams (urgency "quiet") are excluded — muting is an
  // explicit deprioritization signal, so unread messages in a muted stream should
  // not resurface.
  if (urgency !== "quiet" && (unreadCount > 0 || activityCount > 0)) {
    return "recent"
  }

  if (stream.lastMessagePreview) {
    const diff = Date.now() - new Date(stream.lastMessagePreview.createdAt).getTime()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    if (diff < sevenDays) {
      return "recent"
    }
  }

  return "other"
}

/**
 * Truncate content for preview display. Accepts either JSONContent or plain markdown string.
 * Pass `toEmoji` to resolve `:shortcode:` sequences into emoji characters.
 */
export function truncateContent(
  content: JSONContent | string,
  maxLength: number = 50,
  toEmoji?: (shortcode: string) => string | null
): string {
  const markdown = typeof content === "string" ? content : serializeToMarkdown(content)
  const stripped = stripMarkdownToInline(markdown, toEmoji)
  return stripped.length > maxLength ? stripped.slice(0, maxLength) + "..." : stripped
}

/** Get display name for sorting (handles channels, scratchpads, DMs) */
function getStreamSortName(stream: StreamWithPreview): string {
  return (getStreamName(stream) ?? "").toLowerCase()
}

/** Get activity timestamp for sorting (most recent message or creation) */
export function getActivityTime(stream: {
  lastMessagePreview?: { createdAt: string } | null
  createdAt: string
}): number {
  const timestamp = stream.lastMessagePreview?.createdAt ?? stream.createdAt
  return new Date(timestamp).getTime()
}

/**
 * Sort streams by the specified sort type.
 * @param streams - Array of streams to sort (mutates in place for efficiency)
 * @param sortType - Sorting strategy to use
 * @param getUnreadCount - Function to get unread count for a stream
 */
export function sortStreams(
  streams: StreamItemData[],
  sortType: SortType,
  getUnreadCount: (streamId: string) => number
): StreamItemData[] {
  switch (sortType) {
    case "activity":
      return streams.sort((a, b) => getActivityTime(b) - getActivityTime(a))

    case "importance":
      // Mentions first, then AI activity, then by unread count
      return streams.sort((a, b) => {
        if (a.urgency === "mentions" && b.urgency !== "mentions") return -1
        if (a.urgency !== "mentions" && b.urgency === "mentions") return 1
        if (a.urgency === "ai" && b.urgency !== "ai") return -1
        if (a.urgency !== "ai" && b.urgency === "ai") return 1
        return getUnreadCount(b.id) - getUnreadCount(a.id)
      })

    case "alphabetic_active_first":
      // Unreads first (sorted alphabetically), then reads (sorted alphabetically)
      return streams.sort((a, b) => {
        const aUnread = getUnreadCount(a.id) > 0
        const bUnread = getUnreadCount(b.id) > 0
        if (aUnread && !bUnread) return -1
        if (!aUnread && bUnread) return 1
        return getStreamSortName(a).localeCompare(getStreamSortName(b))
      })

    default:
      return streams
  }
}
