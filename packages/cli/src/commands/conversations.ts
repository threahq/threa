import { listConversations, readConversation } from "../ops"
import {
  enumFlag,
  fmtTimestamp,
  intFlag,
  renderList,
  snippet,
  streamLabel,
  stringFlag,
  UsageError,
  type NounSpec,
  type VerbSpec,
} from "../output"
import { CONVERSATION_STATUSES } from "../tools/constants"

const listVerb: VerbSpec = {
  name: "list",
  summary: "List conversations, optionally scoped to a stream",
  usage: "threa conversations list [--stream ref] [--status s] [--cursor c] [--limit n]",
  help:
    "threa conversations list [flags]\n\n" +
    "List conversations (grouped runs of messages under a stream's effective root), newest activity first.\n\n" +
    "Flags:\n" +
    "  --stream ref   scope to a stream (stream_ id or #slug) and its threads\n" +
    "  --status s     " +
    CONVERSATION_STATUSES.join(" | ") +
    "\n" +
    "  --cursor c     pagination cursor from a previous response\n" +
    "  --limit n      max results, <= 100 (default 50)\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    stream: { type: "string" },
    status: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "string" },
  },
  run: (ctx, _positionals, values) =>
    listConversations(ctx.client, ctx.resolver, {
      streamRef: stringFlag(values, "stream"),
      status: enumFlag(values, "status", CONVERSATION_STATUSES),
      cursor: stringFlag(values, "cursor"),
      limit: intFlag(values, "limit"),
    }),
  render: (payload) =>
    renderList<ConversationRow>(payload, renderConversationRow, {
      empty: "(no conversations)",
      cursorFlag: "cursor",
    }),
}

interface ConversationRow {
  id?: string
  status?: string
  topicSummary?: string | null
  summary?: string | null
  messageCount?: number
  lastActivityAt?: string
  stream?: { id?: string; name?: string }
  rootStream?: { id?: string; name?: string }
  streamId?: string
}

function renderConversationRow(c: ConversationRow): string {
  const header = [
    c.id ?? "?",
    c.status ?? "?",
    c.messageCount !== undefined ? `${c.messageCount} msgs` : undefined,
    fmtTimestamp(c.lastActivityAt) || undefined,
    streamLabel(c) || undefined,
  ]
    .filter(Boolean)
    .join("  ")
  const topic = snippet(c.topicSummary ?? c.summary ?? "")
  return topic ? `${header}\n  ${topic}` : header
}

const readVerb: VerbSpec = {
  name: "read",
  summary: "Read a conversation with a page of its messages",
  usage: "threa conversations read <id> [--cursor c] [--limit n]",
  help:
    "threa conversations read <id> [flags]\n\n" +
    "Fetch a conversation and a page of its member messages. Page with --cursor from the previous response.\n\n" +
    "Flags:\n" +
    "  --cursor c   pagination cursor from a previous response\n" +
    "  --limit n    max messages, <= 100 (default 50)\n" +
    "  --json       force JSON output\n" +
    "  --help       show this help",
  options: {
    cursor: { type: "string" },
    limit: { type: "string" },
  },
  run: (ctx, positionals, values) => {
    const id = positionals[0]
    if (!id) throw new UsageError("conversations read requires a <id> (a conv_ id)")
    return readConversation(ctx.client, ctx.resolver, {
      conversationId: id,
      cursor: stringFlag(values, "cursor"),
      limit: intFlag(values, "limit"),
    })
  },
  render: (payload) => {
    const p = payload as {
      conversation?: ConversationRow & { createdAt?: string }
      messages?: {
        data?: Array<{
          author?: { name?: string }
          authorDisplayName?: string
          contentMarkdown?: string
          content?: string
          createdAt?: string
        }>
        hasMore?: boolean
      }
    }
    const lines: string[] = []
    const c = p.conversation
    if (c) {
      lines.push(
        [c.id ?? "?", c.status ?? "?", streamLabel(c) || undefined].filter(Boolean).join("  "),
        [
          fmtTimestamp(c.createdAt) && `created ${fmtTimestamp(c.createdAt)}`,
          fmtTimestamp(c.lastActivityAt) && `last activity ${fmtTimestamp(c.lastActivityAt)}`,
          c.messageCount !== undefined && `${c.messageCount} messages`,
        ]
          .filter(Boolean)
          .join(" · ")
      )
      const topic = snippet(c.topicSummary ?? c.summary ?? "")
      if (topic) lines.push(`topic: ${topic}`)
    }
    const msgs = p.messages?.data ?? []
    lines.push(`messages: ${msgs.length}${p.messages?.hasMore ? " (more)" : ""}`)
    for (const m of msgs) {
      const who = m.author?.name ?? m.authorDisplayName ?? "?"
      const ts = fmtTimestamp(m.createdAt)
      lines.push(`  ${ts ? `[${ts}] ` : ""}${who}: ${snippet(m.contentMarkdown ?? m.content ?? "", 120)}`)
    }
    return lines.join("\n")
  },
}

export const conversationsNoun: NounSpec = {
  name: "conversations",
  summary: "List conversations and read one with its messages",
  verbs: [listVerb, readVerb],
}
