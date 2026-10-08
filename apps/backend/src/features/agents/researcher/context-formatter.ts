import { StreamTypes, type AuthorType } from "@threahq/types"
import type { Querier } from "../../../db"
import { formatInstant } from "../../../lib/temporal"
import { formatAttachWithStreamTag, formatMemoTag, formatMsgRefToken, formatRetrievedMessageTag } from "../pointer-tags"
import { UserRepository } from "../../workspaces"
import { StreamRepository, type Stream } from "../../streams"
import type { Memo } from "../../memos"
import { PersonaRepository } from "../persona-repository"
import { workspaceMemoUrl, workspaceMessageUrl, workspaceStreamUrl } from "../workspace-links"
import type { PersonResolution, ResolvedPerson } from "./people-resolver"

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
  /** Set when the message is a thread reply: the channel the thread hangs off and the post that opened it. */
  thread?: { channelName: string; title: string | null; rootMessageId: string | null }
  /** Posted in the room the research was asked from: its root stream or one of that root's threads. */
  inCurrentRoom?: boolean
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

interface MessageGroup {
  header: string
  inCurrentRoom: boolean
  rootMessageId: string | null
  messages: EnrichedMessageResult[]
}

/**
 * Groups hits by the conversation they belong to: a thread's root post opens its thread's group instead of sitting
 * among the channel's other hits, and the current room's groups come first.
 */
function groupMessages(messages: EnrichedMessageResult[]): MessageGroup[] {
  const threadByRootMessageId = new Map<string, string>()
  for (const msg of messages) {
    if (msg.thread?.rootMessageId) threadByRootMessageId.set(msg.thread.rootMessageId, msg.streamId)
  }

  const groups = new Map<string, MessageGroup>()
  for (const msg of messages) {
    const key = threadByRootMessageId.get(msg.id) ?? msg.streamId
    let group = groups.get(key)
    if (!group) {
      const threadMsg = key === msg.streamId ? msg : messages.find((m) => m.streamId === key)!
      group = {
        header: threadMsg.thread
          ? `Thread in _${threadMsg.thread.channelName}_${threadMsg.thread.title ? `: ${threadMsg.thread.title}` : ""}`
          : `_${msg.streamName}_`,
        inCurrentRoom: false,
        rootMessageId: threadMsg.thread?.rootMessageId ?? null,
        messages: [],
      }
      groups.set(key, group)
    }
    group.inCurrentRoom ||= msg.inCurrentRoom === true
    group.messages.push(msg)
  }

  const ordered = [...groups.values()]
  for (const group of ordered) {
    group.messages.sort(
      (a, b) =>
        Number(b.id === group.rootMessageId) - Number(a.id === group.rootMessageId) ||
        a.createdAt.getTime() - b.createdAt.getTime()
    )
  }
  return [...ordered.filter((g) => g.inCurrentRoom), ...ordered.filter((g) => !g.inCurrentRoom)]
}

function formatMessagesSection(messages: EnrichedMessageResult[], workspaceId: string, timezone: string): string {
  const groupEntries = groupMessages(messages)
    .map((group) => {
      const entries = group.messages
        .map((msg) => {
          const postedAt = formatInstant(msg.createdAt, timezone)
          const author = msg.authorType === "user" ? `@${msg.authorName}` : msg.authorName
          const action = msg.id === group.rootMessageId ? " started the thread" : ""
          const content = msg.content.replace(/\s+/g, " ").trim()
          const quoteBlock = msg.quoteContext ? `\n${msg.quoteContext}` : ""
          // Surface ids needed for `shared-message:` / `quote:` pointer URLs.
          // The pointer formats are taught in the "Referring to messages and
          // attachments" prompt section; this header gives the agent the
          // matching `[msg:… stream:… author:… type:…]` ids without a follow-
          // up tool call. The link is copyable as-is — no id reconstruction.
          const idTag = formatRetrievedMessageTag(msg.id, msg.streamId, msg.authorId, msg.authorType)
          const link = workspaceMessageUrl(workspaceId, msg.streamId, msg.id)

          return `> ${idTag} **${author}**${action} (${postedAt}):
> ${content}${quoteBlock}
> Link: ${link}`
        })
        .join("\n\n")
      const here = group.inCurrentRoom ? " (the room this question was asked in)" : ""
      return `#### ${group.header}${here}

${entries}`
    })
    .join("\n\n")

  return `### Related Messages

Grouped by the conversation they were posted in, oldest first within each.

${groupEntries}

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
  const missingChannelIds = [
    ...new Set(streams.flatMap((s) => (s.rootStreamId && !streamMap.has(s.rootStreamId) ? [s.rootStreamId] : []))),
  ]
  if (missingChannelIds.length > 0) {
    for (const channel of await StreamRepository.findByIds(db, workspaceId, missingChannelIds)) {
      streamMap.set(channel.id, channel)
    }
  }
  const streamName = (stream: Stream | undefined) => stream?.displayName ?? stream?.slug ?? stream?.type ?? "Unknown"

  return results.map((r) => {
    const authorName =
      r.authorType === "user"
        ? (memberMap.get(r.authorId)?.name ?? "Unknown")
        : (personaMap.get(r.authorId)?.name ?? "Assistant")

    const stream = streamMap.get(r.streamId)
    const channel = stream?.rootStreamId ? streamMap.get(stream.rootStreamId) : undefined

    return {
      id: r.id,
      streamId: r.streamId,
      content: r.content,
      authorId: r.authorId,
      authorType: r.authorType,
      authorName,
      streamName: streamName(stream),
      streamType: stream?.type ?? "unknown",
      createdAt: r.createdAt,
      ...(stream?.type === StreamTypes.THREAD
        ? {
            thread: {
              channelName: streamName(channel),
              title: stream.displayName,
              rootMessageId: stream.parentAnchorId,
            },
          }
        : {}),
    }
  })
}

/** What the researcher made of each person the query names, so the agent answers about the right one or asks which. */
export function formatPeopleSection(people: PersonResolution[]): string | null {
  if (people.length === 0) return null
  const lines = people.map((resolution) => {
    switch (resolution.status) {
      case "resolved":
        return `- "${resolution.reference}" is ${personLabel(resolution.person)}.`
      case "ambiguous":
        return resolution.candidates.length === 1
          ? `- "${resolution.reference}" may be ${personLabel(resolution.candidates[0]!)}, but that is not certain.`
          : `- "${resolution.reference}" could be ${resolution.candidates.map(personLabel).join(" or ")}. If the answer depends on which, ask which one is meant, naming them without @-mentions.`
      case "unresolved":
        return `- "${resolution.reference}" could not be matched to anyone. They may still exist.`
    }
  })
  return `## People\n\n${lines.join("\n")}`
}

function personLabel(person: ResolvedPerson): string {
  return `${person.name} (${person.slug})`
}
