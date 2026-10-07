import type { AuthorType } from "@threahq/types"
import type { Querier } from "../../../db"
import { formatInstant } from "../../../lib/temporal"
import { formatAttachWithStreamTag, formatMemoTag, formatMsgRefToken, formatRetrievedMessageTag } from "../pointer-tags"
import { UserRepository } from "../../workspaces"
import { StreamRepository } from "../../streams"
import type { Memo } from "../../memos"
import { PersonaRepository } from "../persona-repository"
import { workspaceMemoUrl, workspaceMessageUrl, workspaceStreamUrl } from "../workspace-links"

export interface EnrichedMemoResult {
  memo: Memo
  distance: number
  sourceStream: {
    id: string
    type: string
    name: string | null
  } | null
  latestSourceAt: Date | null
}

export interface EnrichedMessageResult {
  id: string
  streamId: string
  content: string
  authorId: string
  authorType: AuthorType
  authorName: string
  streamName: string
  streamType: string
  createdAt: Date
  /**
   * Pre-rendered `<quoted-source>` block(s) expanding any quote-reply
   * precursors referenced from this message. Populated by the researcher when
   * the message contains `quoteReply` nodes and their source messages are
   * accessible. Undefined when there is no quoted-source context to add.
   */
  quoteContext?: string
  /** Every stream a quote expansion reached in this batch. */
  quoteStreamIds?: string[]
}

export interface EnrichedAttachmentResult {
  id: string
  filename: string
  mimeType: string
  streamId: string | null
  contentType: string | null
  summary: string | null
  createdAt: Date
}

/**
 * Format retrieved memos, messages, and attachments into a context section for the system prompt.
 *
 * Returns null if no results were found.
 * Otherwise returns a formatted markdown section to inject into the prompt.
 */
export function formatRetrievedContext(
  memos: EnrichedMemoResult[],
  messages: EnrichedMessageResult[],
  attachments: EnrichedAttachmentResult[],
  workspaceId: string,
  /** The asker's clock; UTC when the asker has none. */
  timezone = "UTC"
): string | null {
  if (memos.length === 0 && messages.length === 0 && attachments.length === 0) {
    return null
  }

  const memosSection = memos.length > 0 ? formatMemosSection(memos, workspaceId, timezone) : ""
  const messagesSection = messages.length > 0 ? formatMessagesSection(messages, workspaceId, timezone) : ""
  const attachmentsSection = attachments.length > 0 ? formatAttachmentsSection(attachments, workspaceId, timezone) : ""

  return `## Retrieved Knowledge

The following relevant information was found in the workspace:

${memosSection}${messagesSection}${attachmentsSection}Use this knowledge to inform your response. Cite sources when relevant.`
}

function formatMemosSection(memos: EnrichedMemoResult[], workspaceId: string, timezone: string): string {
  const memoEntries = memos
    .map(({ memo, sourceStream, latestSourceAt }) => {
      const location = sourceStream?.name ?? sourceStream?.type ?? "workspace"
      const keyPointsList =
        memo.keyPoints.length > 0 ? `\nKey points:\n${memo.keyPoints.map((kp) => `- ${kp}`).join("\n")}\n` : ""
      // Surface memo id + source-message ids so the agent can pull source
      // messages via `describe_memo` and forward/quote them with pointer URLs.
      const memoTag = formatMemoTag(memo.id, location, sourceStream?.id)
      const sourcesLine =
        memo.sourceMessageIds.length > 0
          ? `\n_Sources: ${memo.sourceMessageIds.map(formatMsgRefToken).join(", ")}_\n`
          : ""
      const linkLine = `Link: ${workspaceMemoUrl(workspaceId, memo.id)}\n`

      const asOf = formatInstant(latestSourceAt ?? memo.createdAt, timezone)

      return `**${memo.title}** _(${memoTag})_, as of ${asOf}

${memo.abstract}
${keyPointsList}${sourcesLine}${linkLine}`
    })
    .join("\n")

  return `### Memos

Each memo is as of its newest source message. A message posted after that date that explicitly changes or reverses what the memo states overrides it. A question, proposal or passing remark does not.

${memoEntries}
`
}

function formatMessagesSection(messages: EnrichedMessageResult[], workspaceId: string, timezone: string): string {
  const messageEntries = messages
    .map((msg) => {
      const postedAt = formatInstant(msg.createdAt, timezone)
      const author = msg.authorType === "user" ? `@${msg.authorName}` : msg.authorName
      const content = msg.content.replace(/\s+/g, " ").trim()
      const quoteBlock = msg.quoteContext ? `\n${msg.quoteContext}` : ""
      // Surface ids needed for `shared-message:` / `quote:` pointer URLs.
      // The pointer formats are taught in the "Referring to messages and
      // attachments" prompt section; this header gives the agent the
      // matching `[msg:… stream:… author:… type:…]` ids without a follow-
      // up tool call. The link is copyable as-is — no id reconstruction.
      const idTag = formatRetrievedMessageTag(msg.id, msg.streamId, msg.authorId, msg.authorType)
      const link = workspaceMessageUrl(workspaceId, msg.streamId, msg.id)

      return `> ${idTag} **${author}** in _${msg.streamName}_ (${postedAt}):
> ${content}${quoteBlock}
> Link: ${link}`
    })
    .join("\n\n")

  return `### Related Messages

${messageEntries}

`
}

function formatAttachmentsSection(
  attachments: EnrichedAttachmentResult[],
  workspaceId: string,
  timezone: string
): string {
  const attachmentEntries = attachments
    .map((att) => {
      const postedAt = formatInstant(att.createdAt, timezone)
      const contentInfo = att.contentType ? ` (${att.contentType})` : ""
      const summary = att.summary ? `\n${att.summary}` : ""
      // Surface attachment id for `attachment:` resurfacing pointer URLs.
      const attachTag = formatAttachWithStreamTag(att.id, att.streamId)
      const linkLine = att.streamId ? `\nLink: ${workspaceStreamUrl(workspaceId, att.streamId)}` : ""

      return `**${att.filename}**${contentInfo} _(${attachTag}, ${postedAt})_${summary}${linkLine}`
    })
    .join("\n\n")

  return `### Related Attachments

${attachmentEntries}

`
}

export interface RawMessageSearchResult {
  id: string
  streamId: string
  content: string
  authorId: string
  authorType: AuthorType
  createdAt: Date
}

/**
 * Enrich raw message search results with author names and stream names.
 * This is a shared utility used by both the WorkspaceAgent and PersonaAgent search callbacks.
 */
export async function enrichMessageSearchResults(
  db: Querier,
  workspaceId: string,
  results: RawMessageSearchResult[]
): Promise<EnrichedMessageResult[]> {
  if (results.length === 0) return []

  const userIds = new Set<string>()
  const personaIds = new Set<string>()
  const streamIds = new Set<string>()

  for (const r of results) {
    if (r.authorType === "user") {
      userIds.add(r.authorId)
    } else {
      personaIds.add(r.authorId)
    }
    streamIds.add(r.streamId)
  }

  const [members, personas, streams] = await Promise.all([
    userIds.size > 0 ? UserRepository.findByIds(db, workspaceId, [...userIds]) : Promise.resolve([]),
    personaIds.size > 0 ? PersonaRepository.findByIds(db, workspaceId, [...personaIds]) : Promise.resolve([]),
    StreamRepository.findByIds(db, workspaceId, [...streamIds]),
  ])

  const memberMap = new Map(members.map((m) => [m.id, m]))
  const personaMap = new Map(personas.map((p) => [p.id, p]))
  const streamMap = new Map(streams.map((s) => [s.id, s]))

  return results.map((r) => {
    const authorName =
      r.authorType === "user"
        ? (memberMap.get(r.authorId)?.name ?? "Unknown")
        : (personaMap.get(r.authorId)?.name ?? "Assistant")

    const stream = streamMap.get(r.streamId)
    const streamName = stream?.displayName ?? stream?.slug ?? stream?.type ?? "Unknown"

    return {
      id: r.id,
      streamId: r.streamId,
      content: r.content,
      authorId: r.authorId,
      authorType: r.authorType,
      authorName,
      streamName,
      streamType: stream?.type ?? "unknown",
      createdAt: r.createdAt,
    }
  })
}
