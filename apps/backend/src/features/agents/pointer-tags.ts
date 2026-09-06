/**
 * Compact "pointer tags" annotated on prompt context surfaces (conversation
 * history, retrieved-knowledge entries, attachment descriptions). These are
 * NOT the renderable pointer URLs (`shared-message:`, `quote:`, `attachment:`
 * — those live in `@threahq/prosemirror/pointer-urls`); they are the prompt-
 * only id-surfacing format that lets the agent compose pointer URLs without
 * extra tool calls.
 *
 * Centralized here per INV-33 so the prompt format stays consistent across
 * `companion/prompt/message-format.ts` and `researcher/context-formatter.ts`.
 * The `## Referring to messages and attachments` prompt section documents
 * which surfaces use which tags — keep both in sync if you change a prefix.
 */
import type { AuthorType } from "@threahq/types"

/** Bare `[msg:m_x]` — used for messages with no author surface. */
export function formatMsgTag(messageId: string): string {
  return `[msg:${messageId}]`
}

/** `[msg:m_x author:u_y]` — conversation-history user/persona messages. */
export function formatMsgAuthorTag(messageId: string, authorId: string): string {
  return `[msg:${messageId} author:${authorId}]`
}

/** `[msg:m_x stream:s_y author:u_z type:user]` — workspace-research results. */
export function formatRetrievedMessageTag(
  messageId: string,
  streamId: string,
  authorId: string,
  authorType: AuthorType
): string {
  return `[msg:${messageId} stream:${streamId} author:${authorId} type:${authorType}]`
}

/** `attach:a_x` — bare attachment id token (used inside parens). */
export function formatAttachTag(attachmentId: string): string {
  return `attach:${attachmentId}`
}

/** `attach:a_x #N` — image attachment with prompt-stable image index. */
export function formatAttachImageTag(attachmentId: string, imageIndex: number): string {
  return `attach:${attachmentId} #${imageIndex}`
}

/** `attach:a_x stream:s_y` (stream segment optional). */
export function formatAttachWithStreamTag(attachmentId: string, streamId?: string | null): string {
  return streamId ? `attach:${attachmentId} stream:${streamId}` : `attach:${attachmentId}`
}

/** `memo:m_x from <location> stream:s_y` — workspace-research memo header. */
export function formatMemoTag(memoId: string, location: string, streamId?: string | null): string {
  const streamSegment = streamId ? ` stream:${streamId}` : ""
  return `memo:${memoId} from ${location}${streamSegment}`
}

/** `msg:m_x` — used inside `Sources: msg:…, msg:…` lines on memo entries. */
export function formatMsgRefToken(messageId: string): string {
  return `msg:${messageId}`
}

/** `stream:s_x` — bare stream segment. */
export function formatStreamTag(streamId: string): string {
  return `stream:${streamId}`
}
