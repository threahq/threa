import { getMemo, recallMemos, search } from "../ops"
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

const recallVerb: VerbSpec = {
  name: "recall",
  summary: "Recall the memos relevant to a message",
  usage: "threa memos recall <message>",
  help:
    "threa memos recall <message>\n\n" +
    "Pass the message you are about to answer; get back the few memos that help with it (at most 5), " +
    "scored for relevance by a model. Nothing comes back when memory holds nothing relevant. To explore " +
    "memory by idea or filter, use `threa search --what memos`.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const message = positionals.join(" ").trim()
    if (!message) throw new UsageError("memos recall requires a <message>")
    return recallMemos(ctx.client, message)
  },
  render: (payload) => {
    const { data = [], outcome } = payload as { data?: Array<Record<string, unknown>>; outcome?: string }
    if (data.length > 0) return data.map((memo) => renderSearchResult({ memo })).join("\n")
    if (outcome === "nothing_relevant" || outcome === "no_candidates") return "(nothing relevant)"
    return `(recall ${outcome ?? "failed"}; try \`threa search --what memos\`)`
  },
}

export const memosNoun: NounSpec = {
  name: "memos",
  summary: "List, recall, and get memos",
  verbs: [listVerb, recallVerb, getVerb],
}
