import { getMemo, search } from "../ops"
import { arrayFlag, intFlag, UsageError, type NounSpec, type VerbSpec } from "../output"
import { renderSearchResult } from "./search"

const listVerb: VerbSpec = {
  name: "list",
  summary: "List the most recent memos, optionally scoped to streams",
  usage: "threa memos list [--stream ref]... [--limit n]",
  help:
    "threa memos list [flags]\n\n" +
    "Browse preserved workspace memos, newest first (a query-less memo search). Filter further with " +
    "`threa search --what memos`.\n\n" +
    "Flags:\n" +
    "  --stream ref   limit to a source stream (stream_ id or #slug); repeatable\n" +
    "  --limit n      max results, <= 100 (default 20)\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    stream: { type: "string", multiple: true },
    limit: { type: "string" },
  },
  run: (ctx, _positionals, values) =>
    search(ctx.client, ctx.resolver, {
      what: "memos",
      stream_ids: arrayFlag(values, "stream"),
      limit: intFlag(values, "limit"),
    }),
  render: (payload) => {
    const rows = (payload as { data?: Array<Record<string, unknown>> }).data ?? []
    return rows.map(renderSearchResult).join("\n") || "(no memos)"
  },
}

const getVerb: VerbSpec = {
  name: "get",
  summary: "Get a memo by id, with its source-message provenance",
  usage: "threa memos get <id>",
  help:
    "threa memos get <id>\n\n" +
    "Retrieve one memo by id, with its source stream and the source messages it was extracted from " +
    "(provenance). Find memos in the first place with `threa memos list` or `threa search --what memos`.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const id = positionals[0]
    if (!id) throw new UsageError("memos get requires a <id> (a memo_ id)")
    return getMemo(ctx.client, id)
  },
}

export const memosNoun: NounSpec = {
  name: "memos",
  summary: "List memos and get one by id",
  verbs: [listVerb, getVerb],
}
