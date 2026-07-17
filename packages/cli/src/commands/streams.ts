import { listStreams, readStream } from "../ops"
import {
  boolFlag,
  cursorFooter,
  enumArrayFlag,
  intFlag,
  renderList,
  stringFlag,
  UsageError,
  type NounSpec,
  type VerbSpec,
} from "../output"
import { STREAM_TYPES } from "../tools/constants"

interface StreamRow {
  id?: string
  type?: string
  displayName?: string
  name?: string
  slug?: string
}

function streamLabel(s: StreamRow): string {
  return s.displayName ?? s.name ?? (s.slug ? `#${s.slug}` : (s.id ?? "?"))
}

const listVerb: VerbSpec = {
  name: "list",
  summary: "List streams this key can access",
  usage: "threa streams list [--type t]... [--query q] [--after cursor] [--limit n] [--archived]",
  help:
    "threa streams list [flags]\n\n" +
    "List streams this key can access. Page by passing the previous response's cursor back as --after.\n\n" +
    "Flags:\n" +
    "  --type t     filter by stream type (" +
    STREAM_TYPES.join("|") +
    "); repeatable\n" +
    "  --query q    text match on stream name\n" +
    "  --after c    pagination cursor from a previous response\n" +
    "  --limit n    max results, <= 200 (default 50)\n" +
    "  --archived   include archived streams and threads under archived roots\n" +
    "  --json       force JSON output\n" +
    "  --help       show this help",
  options: {
    type: { type: "string", multiple: true },
    query: { type: "string" },
    after: { type: "string" },
    limit: { type: "string" },
    archived: { type: "boolean" },
  },
  run: (ctx, _positionals, values) =>
    listStreams(ctx.client, {
      type: enumArrayFlag(values, "type", STREAM_TYPES),
      query: stringFlag(values, "query"),
      after: stringFlag(values, "after"),
      limit: intFlag(values, "limit"),
      includeArchived: boolFlag(values, "archived"),
    }),
  render: (payload) =>
    renderList<StreamRow>(payload, (s) => `${s.id ?? "?"}  ${s.type ?? "?"}  ${streamLabel(s)}`, {
      empty: "(no streams)",
      cursorFlag: "after",
    }),
}

const readVerb: VerbSpec = {
  name: "read",
  summary: "Read a stream with a page of its messages (accepts a stream_ id or #slug)",
  usage: "threa streams read <ref> [--members] [--before seq] [--after seq] [--limit n]",
  help:
    "threa streams read <ref> [flags]\n\n" +
    "Fetch a stream and a page of its messages. <ref> is a stream_ id or a #channel-slug.\n" +
    "Message paging is by numeric sequence, not a cursor: --before returns older messages, --after newer; " +
    "pass at most one and walk pages by the boundary message's sequence.\n\n" +
    "Flags:\n" +
    "  --members    also fetch the stream's members\n" +
    "  --before seq messages before this sequence (older)\n" +
    "  --after seq  messages after this sequence (newer)\n" +
    "  --limit n    max messages, <= 100 (default 50)\n" +
    "  --json       force JSON output\n" +
    "  --help       show this help",
  options: {
    members: { type: "boolean" },
    before: { type: "string" },
    after: { type: "string" },
    limit: { type: "string" },
  },
  run: (ctx, positionals, values) => {
    const ref = positionals[0]
    if (!ref) throw new UsageError("streams read requires a <ref> (a stream_ id or #channel-slug)")
    return readStream(ctx.client, ctx.resolver, {
      streamId: ref,
      includeMembers: boolFlag(values, "members"),
      before: stringFlag(values, "before"),
      after: stringFlag(values, "after"),
      limit: intFlag(values, "limit"),
    })
  },
  render: (payload) => {
    const p = payload as {
      stream?: StreamRow
      messages?: {
        data?: Array<{ sequence?: unknown; author?: { name?: string }; contentMarkdown?: string; content?: string }>
        hasMore?: boolean
      }
      members?: { data?: Array<{ id?: string; name?: string; slug?: string }> }
    }
    const lines: string[] = []
    if (p.stream) lines.push(`stream: ${p.stream.id ?? "?"}  ${streamLabel(p.stream)}`)
    const msgs = p.messages?.data ?? []
    lines.push(`messages: ${msgs.length}${p.messages?.hasMore ? " (more)" : ""}`)
    for (const m of msgs) {
      const body = (m.contentMarkdown ?? m.content ?? "").replace(/\s+/g, " ").trim()
      lines.push(`  [${String(m.sequence ?? "?")}] ${m.author?.name ?? "?"}: ${body.slice(0, 120)}`)
    }
    if (p.members) {
      lines.push(`members: ${(p.members.data ?? []).length}`)
      for (const mem of p.members.data ?? []) lines.push(`  ${mem.id ?? "?"} ${mem.name ?? ""}`.trimEnd())
    }
    return lines.join("\n")
  },
}

export const streamsNoun: NounSpec = {
  name: "streams",
  summary: "List streams and read a stream with its messages",
  verbs: [listVerb, readVerb],
}
