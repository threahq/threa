import { serializeToMarkdown } from "@threa/prosemirror"
import { AuthorTypes, type AuthorType, type JSONContent, type StreamWithPreview } from "@threa/types"
import { stripMarkdownToInline } from "@/lib/markdown"
import { getStreamName } from "@/lib/streams"
import type { SectionKey, SortType, StreamItemData, UrgencyLevel } from "./types"

/** Minimal stream shape needed for urgency calculation */
interface StreamWithOptionalPreview {
  lastMessagePreview?: { authorType: AuthorType } | null
}

/** Calculate urgency level for a stream based on unread and mention state */
export function calculateUrgency(
  stream: StreamWithOptionalPreview,
  unreadCount: number,
  mentionCount: number,
  isMuted: boolean
): UrgencyLevel {
  if (isMuted) return "quiet"

  if (mentionCount > 0) return "mentions"

  if (unreadCount > 0) {
    const authorType = stream.lastMessagePreview?.authorType
    if (authorType === AuthorTypes.PERSONA) return "ai"
    if (authorType === AuthorTypes.BOT) return "bot"
    return "activity"
  }

  return "quiet"
}

/** Categorize stream into smart section */
export function categorizeStream(stream: StreamWithPreview, unreadCount: number, urgency: UrgencyLevel): SectionKey {
  // TODO: Add pinned support when backend implements it
  // if (stream.isPinned && unreadCount > 0) return "important"
  // if (stream.isPinned) return "pinned"

  // Important: mentions or AI activity with unread
  if (urgency === "mentions" || (urgency === "ai" && unreadCount > 0)) {
    return "important"
  }

  // Any stream with unread activity stays in Recent regardless of age or
  // whether a preview has been cached yet. An active chat should never sink
  // into "Everything else" while the user is still catching up. Muted streams
  // (urgency "quiet") are excluded — muting is an explicit deprioritization
  // signal, so unread messages in a muted stream should not resurface.
  if (unreadCount > 0 && urgency !== "quiet") {
    return "recent"
  }

  // Recent: activity in last 7 days
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
      // Most recent activity first
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
