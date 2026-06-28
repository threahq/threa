import type { Message } from "../messaging"
import type { AttachmentSummary, LinkPreviewSummary } from "@threa/types"

/**
 * Opening/reply message of a board post (internal, Date-typed; serialized to the
 * wire `BoardPostMessage` by JSON). A lean projection of the full message — the
 * fields the post card renders.
 */
export interface BoardPostMessage {
  id: string
  authorId: string
  authorType: Message["authorType"]
  contentMarkdown: string
  reactions: Record<string, string[]>
  attachments: AttachmentSummary[]
  linkPreviews: LinkPreviewSummary[]
  createdAt: Date
}

/** Project a full message + its hydrated rich content down to a board post message. */
export function toBoardPostMessage(
  message: Message,
  attachments: AttachmentSummary[],
  linkPreviews: LinkPreviewSummary[]
): BoardPostMessage {
  return {
    id: message.id,
    authorId: message.authorId,
    authorType: message.authorType,
    contentMarkdown: message.contentMarkdown,
    reactions: message.reactions,
    attachments,
    linkPreviews,
    createdAt: message.createdAt,
  }
}

/**
 * Project a just-arrived message for the live `conversation:*` payload — text,
 * author, reactions, time — leaving attachments/link previews empty. The board
 * appends it to the card preview so a new reply's body shows live, not just the
 * activity bump; the enrichment fills in on the next board seed or on expand (a
 * full hydrated fetch). Inline here so the message-send hot path skips the
 * attachment/link-preview reads.
 */
export function toLiveBoardPostMessage(message: Message): BoardPostMessage {
  return toBoardPostMessage(message, [], [])
}
