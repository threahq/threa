import { deleteMessage, findMessagesByMetadata, sendConversationArgError, sendMessage, updateMessage } from "../ops"
import { arrayFlag, boolFlag, intFlag, kvPairs, stringFlag, UsageError, type CommandSpec } from "../output"

async function resolveContent(raw: string, readStdin: () => Promise<string>): Promise<string> {
  const content = raw === "-" ? await readStdin() : raw
  if (content.trim() === "") throw new UsageError("content is empty")
  return content
}

export const findByMetadataCommand: CommandSpec = {
  name: "find-by-metadata",
  summary: "Find messages whose metadata contains every given key=value pair",
  usage: "threa find-by-metadata k=v [k=v ...] [--stream ref] [--limit n]",
  help:
    "threa find-by-metadata k=v [k=v ...] [flags]\n\n" +
    "Find non-deleted messages whose metadata contains every given key=value pair (exact AND-containment, not " +
    "text search). Use it to dedup by an external reference you stamped at send time, e.g. github.pr=org/repo#42.\n\n" +
    "Flags:\n" +
    "  --stream ref   narrow to a stream (stream_ id or #slug)\n" +
    "  --limit n      max results, <= 100 (default 20)\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    stream: { type: "string" },
    limit: { type: "string" },
  },
  run: (ctx, positionals, values) => {
    if (positionals.length === 0) {
      throw new UsageError("find-by-metadata requires at least one k=v pair")
    }
    return findMessagesByMetadata(ctx.client, ctx.resolver, {
      metadata: kvPairs(positionals),
      streamRef: stringFlag(values, "stream"),
      limit: intFlag(values, "limit"),
    })
  },
  render: (payload) => {
    const p = payload as { data?: Array<{ id?: string; streamId?: string; author?: { name?: string } }> }
    const rows = p.data ?? []
    return (
      rows.map((m) => `${m.id ?? "?"}  ${m.streamId ?? "?"}  ${m.author?.name ?? ""}`.trimEnd()).join("\n") ||
      "(no matches)"
    )
  },
}

export const sendCommand: CommandSpec = {
  name: "send",
  summary: "Post a markdown message to a stream (content `-` reads stdin)",
  usage:
    "threa send <stream-ref> <content> [--new-conversation | --conversation conv_id] [--metadata k=v]... " +
    "[--client-message-id id]",
  help:
    "threa send <stream-ref> <content> [flags]\n\n" +
    "Post a markdown message to a stream. <stream-ref> is a stream_ id or #channel-slug. Pass content as the " +
    "second positional, or `-` to read it from stdin. A client message id is auto-generated (mcp-<uuid>) when " +
    "you omit --client-message-id, so a retried send never double-posts; the effective id is returned as " +
    "clientMessageId.\n\n" +
    "Flags:\n" +
    "  --new-conversation      open a fresh conversation (mutually exclusive with --conversation)\n" +
    "  --conversation conv_id  append to an existing conversation under the same root stream\n" +
    "  --metadata k=v          stamp flat string metadata; repeatable\n" +
    "  --client-message-id id  set the idempotency key explicitly (<= 128 chars)\n" +
    "  --json                  force JSON output\n" +
    "  --help                  show this help",
  options: {
    "new-conversation": { type: "boolean" },
    conversation: { type: "string" },
    metadata: { type: "string", multiple: true },
    "client-message-id": { type: "string" },
  },
  run: async (ctx, positionals, values) => {
    const ref = positionals[0]
    if (!ref) throw new UsageError("send requires a <stream-ref> (a stream_ id or #channel-slug)")
    const rawContent = positionals[1]
    if (rawContent === undefined) throw new UsageError("send requires <content> (or `-` to read stdin)")
    const startConversation = boolFlag(values, "new-conversation")
    const conversationId = stringFlag(values, "conversation")
    if (sendConversationArgError({ conversationId, startConversation })) {
      throw new UsageError("pass either --new-conversation or --conversation conv_id, not both")
    }
    const metadataPairs = arrayFlag(values, "metadata")
    return sendMessage(ctx.client, ctx.resolver, {
      streamRef: ref,
      content: await resolveContent(rawContent, ctx.readStdin),
      clientMessageId: stringFlag(values, "client-message-id"),
      metadata: metadataPairs ? kvPairs(metadataPairs) : undefined,
      conversationId,
      startConversation,
    })
  },
  render: (payload) => {
    const p = payload as { data?: { id?: string }; conversationId?: string; clientMessageId?: string }
    const lines = [`sent ${p.data?.id ?? "?"}`]
    if (p.conversationId) lines.push(`conversation: ${p.conversationId}`)
    if (p.clientMessageId) lines.push(`clientMessageId: ${p.clientMessageId}`)
    return lines.join("\n")
  },
}

export const editCommand: CommandSpec = {
  name: "edit",
  summary: "Replace a message's content (only messages this key sent)",
  usage: "threa edit <message-id> <content>",
  help:
    "threa edit <message-id> <content> [flags]\n\n" +
    "Replace a message's content with new markdown. Only works on messages this API key sent — the API rejects " +
    "edits to any other author's message.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const messageId = positionals[0]
    if (!messageId) throw new UsageError("edit requires a <message-id>")
    const content = positionals[1]
    if (content === undefined || content.trim() === "") throw new UsageError("edit requires <content>")
    return updateMessage(ctx.client, messageId, content)
  },
  render: (payload) => `edited ${(payload as { data?: { id?: string } }).data?.id ?? "?"}`,
}

export const deleteCommand: CommandSpec = {
  name: "delete",
  summary: "Delete a message (only messages this key sent)",
  usage: "threa delete <message-id>",
  help:
    "threa delete <message-id> [flags]\n\n" +
    "Delete a message. Only works on messages this API key sent — the API rejects deletes of any other " +
    "author's message.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const messageId = positionals[0]
    if (!messageId) throw new UsageError("delete requires a <message-id>")
    return deleteMessage(ctx.client, messageId)
  },
  render: (payload) => `deleted ${(payload as { message_id?: string }).message_id ?? "?"}`,
}
