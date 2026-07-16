import { listConversations, readConversation } from "../ops"
import { cursorFooter, enumFlag, intFlag, stringFlag, UsageError, type CommandSpec } from "../output"
import { CONVERSATION_STATUSES } from "../tools/constants"

export const conversationsCommand: CommandSpec = {
  name: "conversations",
  summary: "List conversations, optionally scoped to a stream",
  usage: "threa conversations [--stream ref] [--status s] [--cursor c] [--limit n]",
  help:
    "threa conversations [flags]\n\n" +
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
  render: (payload) => {
    const p = payload as {
      data?: Array<{ id?: string; status?: string; title?: string; summary?: string }>
      hasMore?: boolean
      cursor?: string | null
    }
    const rows = p.data ?? []
    const lines = rows.map((c) => `${c.id ?? "?"}  ${c.status ?? "?"}  ${c.title ?? c.summary ?? ""}`.trimEnd())
    lines.push(...cursorFooter(p, "cursor"))
    return lines.join("\n") || "(no conversations)"
  },
}

export const conversationCommand: CommandSpec = {
  name: "conversation",
  summary: "Read a conversation with a page of its messages",
  usage: "threa conversation <id> [--cursor c] [--limit n]",
  help:
    "threa conversation <id> [flags]\n\n" +
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
    if (!id) throw new UsageError("conversation requires a <id> (a conv_ id)")
    return readConversation(ctx.client, ctx.resolver, {
      conversationId: id,
      cursor: stringFlag(values, "cursor"),
      limit: intFlag(values, "limit"),
    })
  },
  render: (payload) => {
    const p = payload as {
      conversation?: { id?: string; status?: string; title?: string }
      messages?: {
        data?: Array<{ author?: { name?: string }; contentMarkdown?: string; content?: string }>
        hasMore?: boolean
      }
    }
    const lines: string[] = []
    if (p.conversation)
      lines.push(
        `conversation: ${p.conversation.id ?? "?"}  ${p.conversation.status ?? ""}  ${p.conversation.title ?? ""}`.trimEnd()
      )
    const msgs = p.messages?.data ?? []
    lines.push(`messages: ${msgs.length}${p.messages?.hasMore ? " (more)" : ""}`)
    for (const m of msgs) {
      const body = (m.contentMarkdown ?? m.content ?? "").replace(/\s+/g, " ").trim()
      lines.push(`  ${m.author?.name ?? "?"}: ${body.slice(0, 120)}`)
    }
    return lines.join("\n")
  },
}
