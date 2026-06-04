import type { ModelMessage } from "ai"
import { AuthorTypes, StreamTypes, type ChartData, type DiagramData, type TableData } from "@threa/types"
import { formatDate, formatTime, getDateKey } from "../../../../lib/temporal"
import type { AttachmentContext, MessageWithAttachments, StreamContext } from "../../context-builder"
import { formatAttachImageTag, formatAttachTag, formatMsgAuthorTag } from "../../pointer-tags"

/**
 * Format messages for the LLM with timestamps and author names.
 * Includes date boundaries when messages cross dates.
 *
 * Returns ModelMessage[] with enriched content:
 * - User messages: `[msg:m_x author:u_y] (14:30) [@name] content`
 * - Assistant messages: `[msg:m_x] content` (no timestamp to avoid model mimicking)
 *
 * The `[msg:… author:…]` tag is structural — it gives the agent the IDs it
 * needs to emit `shared-message:` / `quote:` pointer URLs that point back at a
 * specific message in this conversation. Stream id is surfaced once in the
 * stream-context section rather than per-message; all messages in
 * `conversationHistory` belong to the same stream by construction.
 *
 * Attachments are included as text descriptions (captions/summaries) annotated
 * with the attachment id (and a per-prompt image index for images) so the
 * agent can resurface them via `[Image #N](attachment:att_x)` /
 * `[filename](attachment:att_x)`.
 *
 * Actual images are loaded on-demand via the load_attachment tool.
 */
export function formatMessagesWithTemporal(
  messages: MessageWithAttachments[],
  context: StreamContext,
  /**
   * Resolved actor names (users + personas) for the conversation, used both for
   * the `[@name]` author prefix in multi-user streams and for naming reactors in
   * the per-message reactions annotation. Superset of `context.participants`;
   * when omitted, names fall back to participants only.
   */
  actorNames?: Map<string, string>
): ModelMessage[] {
  const temporal = context.temporal

  // Number image attachments in conversation order so the agent can reference
  // them with stable `[Image #N]` text. Counter is shared across all messages.
  const imageIndexById = new Map<string, number>()
  let nextImageIndex = 1
  for (const m of messages) {
    if (!m.attachments) continue
    for (const a of m.attachments) {
      if (a.mimeType.startsWith("image/") && !imageIndexById.has(a.id)) {
        imageIndexById.set(a.id, nextImageIndex++)
      }
    }
  }

  // Build authorId -> name map from participants, overlaid with the richer
  // resolved names (personas, non-participant reactors) when provided.
  const names = new Map<string, string>()
  if (context.participants) {
    for (const p of context.participants) {
      names.set(p.id, p.name)
    }
  }
  if (actorNames) {
    for (const [id, name] of actorNames) names.set(id, name)
  }

  if (!temporal) {
    // No temporal context - return messages with original content + attachment context
    return messages.map((m) => ({
      role: m.authorType === AuthorTypes.USER ? ("user" as const) : ("assistant" as const),
      content: formatMessageContent(m, `${idTag(m)} `, imageIndexById, names),
    }))
  }

  const authorNames = names

  const result: ModelMessage[] = []
  let currentDateKey: string | null = null

  for (const msg of messages) {
    const role = msg.authorType === AuthorTypes.USER ? ("user" as const) : ("assistant" as const)

    if (msg.authorType === AuthorTypes.USER) {
      // Check for date boundary - only on user messages to avoid model mimicking the format
      const msgDateKey = getDateKey(msg.createdAt, temporal.timezone)
      let dateBoundaryPrefix = ""
      if (msgDateKey !== currentDateKey) {
        const dateStr = formatDate(msg.createdAt, temporal.timezone, temporal.dateFormat)
        dateBoundaryPrefix = `[Date: ${dateStr}]\n`
        currentDateKey = msgDateKey
      }

      // Format with timestamp and optional author name for multi-user contexts
      const time = formatTime(msg.createdAt, temporal.timezone, temporal.timeFormat)
      const authorName = authorNames.get(msg.authorId) ?? "Unknown"
      const hasMultipleUsers = context.streamType === StreamTypes.CHANNEL || context.streamType === StreamTypes.DM
      const namePrefix = hasMultipleUsers ? `[@${authorName}] ` : ""
      const textPrefix = `${idTag(msg)} ${dateBoundaryPrefix}(${time}) ${namePrefix}`

      result.push({
        role,
        content: formatMessageContent(msg, textPrefix, imageIndexById, names),
      })
    } else {
      // Assistant/persona messages - no timestamp or date markers to avoid model mimicking
      result.push({
        role,
        content: formatMessageContent(msg, `${idTag(msg)} `, imageIndexById, names),
      })
    }
  }

  return result
}

/**
 * Compact ID tag for inline use in formatted messages. Always includes
 * `author:<id>` so the `quote:stream/msg/author/actorType` pointer-URL
 * contract roundtrips for both user and persona messages — agents need
 * the persona id to losslessly quote their own previous turns.
 */
function idTag(msg: MessageWithAttachments): string {
  return formatMsgAuthorTag(msg.id, msg.authorId)
}

/**
 * Format structured data as compact JSON for inclusion in attachment descriptions.
 * Note: Label avoids "data:" pattern which Langfuse SDK incorrectly parses as data URI.
 */
function formatStructuredData(data: ChartData | TableData | DiagramData | null): string | null {
  if (!data) return null

  // For tables with many rows, truncate to avoid context bloat
  if ("rows" in data && Array.isArray(data.rows) && data.rows.length > 10) {
    const truncated = {
      ...data,
      rows: data.rows.slice(0, 10),
      _truncated: `${data.rows.length - 10} more rows`,
    }
    return `  Parsed: ${JSON.stringify(truncated)}`
  }

  return `  Parsed: ${JSON.stringify(data)}`
}

/**
 * Format a single attachment as a text description, annotated with the
 * attachment id (and per-prompt image index) so the agent can resurface it
 * via `[Image #N](attachment:att_x)` or `[filename](attachment:att_x)`.
 */
function formatAttachmentDescription(att: AttachmentContext, imageIndexById: Map<string, number>): string {
  const isImage = att.mimeType.startsWith("image/")
  const imageIndex = isImage ? imageIndexById.get(att.id) : undefined
  const idTag = isImage && imageIndex ? formatAttachImageTag(att.id, imageIndex) : formatAttachTag(att.id)
  let desc = isImage
    ? `[Image: ${att.filename} (${idTag})]`
    : `[Attachment: ${att.filename} (${att.mimeType}, ${idTag})]`

  if (att.extraction) {
    if (isImage) {
      if (att.extraction.summary) {
        desc += ` - ${att.extraction.summary}`
      }
    } else {
      desc += `\n  Content type: ${att.extraction.contentType}`
      desc += `\n  Summary: ${att.extraction.summary}`
      if (att.extraction.fullText) {
        desc += `\n  Full content: ${att.extraction.fullText}`
      }
    }
    const structuredStr = formatStructuredData(att.extraction.structuredData)
    if (structuredStr) {
      desc += `\n${structuredStr}`
    }
  }

  return desc
}

/**
 * Format message content including attachment context as text descriptions.
 * Actual images are loaded on-demand via the load_attachment tool.
 */
function formatMessageContent(
  msg: MessageWithAttachments,
  textPrefix: string = "",
  imageIndexById: Map<string, number> = new Map(),
  actorNames: Map<string, string> = new Map()
): string {
  let content = textPrefix + msg.contentMarkdown

  if (msg.attachments && msg.attachments.length > 0) {
    const descriptions = msg.attachments.map((a) => formatAttachmentDescription(a, imageIndexById))
    content += "\n\n" + descriptions.join("\n\n")
  }

  const reactionLine = formatReactions(msg.reactions, actorNames)
  if (reactionLine) {
    content += "\n" + reactionLine
  }

  return content
}

/**
 * Render a message's reactions as a compact, model-readable annotation so the
 * agent is aware of how people (and it) have reacted, e.g.
 * `[Reactions: :+1: by Alice, Bob; :tada: by Ariadne]`. Emoji are kept as their
 * shortcodes (self-describing) and reactors are named via the resolved actor
 * map, falling back to "someone" for ids we couldn't resolve.
 */
function formatReactions(reactions: Record<string, string[]>, actorNames: Map<string, string>): string | null {
  const entries = Object.entries(reactions).filter(([, userIds]) => userIds.length > 0)
  if (entries.length === 0) return null

  const parts = entries.map(([emoji, userIds]) => {
    const who = userIds.map((id) => actorNames.get(id) ?? "someone").join(", ")
    return `${emoji} by ${who}`
  })
  return `[Reactions: ${parts.join("; ")}]`
}
