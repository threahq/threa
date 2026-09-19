import { listStreams, readStream, setStreamArchived } from "../ops"
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
import { KEY_STORE_FLAGS, KEY_STORE_OPTIONS, storeChoice } from "./key-store"

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
    'An end-to-end-encrypted stream is read with the key this machine holds, so run "threa e2e unlock" ' +
    "first — without it the bodies cannot be opened here, and the command says so rather than printing the " +
    "placeholder the server stores. A message sealed to a key generation you were never wrapped to keeps a " +
    "null content and reports why, alone among the page.\n\n" +
    "Flags:\n" +
    "  --members    also fetch the stream's members\n" +
    "  --before seq messages before this sequence (older)\n" +
    "  --after seq  messages after this sequence (newer)\n" +
    "  --limit n    max messages, <= 100 (default 50)\n" +
    KEY_STORE_FLAGS +
    "  --json       force JSON output\n" +
    "  --help       show this help",
  options: {
    members: { type: "boolean" },
    before: { type: "string" },
    after: { type: "string" },
    limit: { type: "string" },
    ...KEY_STORE_OPTIONS,
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
      sealed: ctx.sealed(storeChoice(values, ctx.config)),
    })
  },
  render: (payload) => {
    const p = payload as {
      stream?: StreamRow
      messages?: {
        data?: Array<{
          sequence?: unknown
          author?: { name?: string }
          contentMarkdown?: string
          content?: string | null
          unreadableReason?: string
        }>
        hasMore?: boolean
      }
      members?: { data?: Array<{ id?: string; name?: string; slug?: string }> }
    }
    const lines: string[] = []
    if (p.stream) lines.push(`stream: ${p.stream.id ?? "?"}  ${streamLabel(p.stream)}`)
    const msgs = p.messages?.data ?? []
    lines.push(`messages: ${msgs.length}${p.messages?.hasMore ? " (more)" : ""}`)
    for (const m of msgs) {
      const body = m.unreadableReason
        ? `<unreadable: ${m.unreadableReason}>`
        : (m.contentMarkdown ?? m.content ?? "").replace(/\s+/g, " ").trim()
      lines.push(`  [${String(m.sequence ?? "?")}] ${m.author?.name ?? "?"}: ${body.slice(0, 120)}`)
    }
    if (p.members) {
      lines.push(`members: ${(p.members.data ?? []).length}`)
      for (const mem of p.members.data ?? []) lines.push(`  ${mem.id ?? "?"} ${mem.name ?? ""}`.trimEnd())
    }
    return lines.join("\n")
  },
}

function archiveVerb(archived: boolean): VerbSpec {
  const name = archived ? "archive" : "unarchive"
  const effect = archived
    ? "Archive a stream: it goes read-only and every thread beneath it is sealed with it."
    : "Reopen an archived stream. An archived ancestor keeps the subtree sealed until it is reopened too."
  return {
    name,
    summary: `${archived ? "Archive" : "Unarchive"} a stream (accepts a stream_ id or #slug)`,
    usage: `threa streams ${name} <ref>`,
    help:
      `threa streams ${name} <ref>\n\n` +
      `${effect}\n` +
      "<ref> is a stream_ id or a #channel-slug. Open to the stream's creator and, for a user key, the creator " +
      "of its root; a workspace key acts for its bot and reaches only the streams that bot opened. Repeating " +
      `the call is a no-op. An archived channel is not resolvable by #slug — pass its stream_ id.\n\n` +
      "Flags:\n" +
      "  --json       force JSON output\n" +
      "  --help       show this help",
    options: {},
    run: (ctx, positionals) => {
      const ref = positionals[0]
      if (!ref) throw new UsageError(`streams ${name} requires a <ref> (a stream_ id or #channel-slug)`)
      return setStreamArchived(ctx.client, ctx.resolver, { streamRef: ref, archived })
    },
    render: (payload) => {
      const stream = (payload as { data: StreamRow & { archivedAt?: string | null } }).data
      return `${stream.id ?? "?"}  ${streamLabel(stream)}  ${stream.archivedAt ? `archived ${stream.archivedAt}` : "active"}`
    },
  }
}

export const streamsNoun: NounSpec = {
  name: "streams",
  summary: "List streams, read one with its messages, archive and unarchive",
  verbs: [listVerb, readVerb, archiveVerb(true), archiveVerb(false)],
}
