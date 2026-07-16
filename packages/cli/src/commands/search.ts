import { search, SEARCH_WHATS, type SearchArgs, type SearchWhat } from "../ops"
import { arrayFlag, intFlag, stringFlag, UsageError, type CommandSpec } from "../output"
import { EXTRACTION_CONTENT_TYPES, KNOWLEDGE_TYPES, MEMO_SCOPES, MEMO_TYPES, STREAM_TYPES } from "../tools/constants"

export const searchCommand: CommandSpec = {
  name: "search",
  summary: "Search the workspace across messages, memos, or attachments",
  usage: "threa search [query] --what messages|memos|attachments [per-what filters]",
  help:
    "threa search [query] --what messages|memos|attachments [flags]\n\n" +
    "One search routed by --what. Only the filters valid for the chosen --what are accepted; passing another " +
    "is an error naming the offending flag. query is required for messages and attachments; for memos it is " +
    "optional (omit it to browse the most recent memos).\n\n" +
    "Common flags:\n" +
    "  --what w         messages | memos | attachments (required)\n" +
    "  --stream ref     limit to a source stream (stream_ id or #slug); repeatable\n" +
    "  --limit n        max results (messages/attachments <= 50, memos <= 100; default 20)\n" +
    "  --before iso     only results before this ISO-8601 datetime (messages and memos only)\n" +
    "  --after iso      only results after this ISO-8601 datetime (messages and memos only)\n" +
    "messages: --semantic  --exact  --type " +
    STREAM_TYPES.join("|") +
    " (repeatable)\n" +
    "memos:    --exact  --memo-type " +
    MEMO_TYPES.join("|") +
    " (repeatable)  --knowledge-type " +
    KNOWLEDGE_TYPES.join("|") +
    " (repeatable)  --tag t (repeatable)  --scope " +
    MEMO_SCOPES.join("|") +
    "\n" +
    "attachments: --content-type " +
    EXTRACTION_CONTENT_TYPES.join("|") +
    " (repeatable)\n" +
    "  --json           force JSON output\n" +
    "  --help           show this help",
  options: {
    what: { type: "string" },
    semantic: { type: "boolean" },
    exact: { type: "boolean" },
    stream: { type: "string", multiple: true },
    type: { type: "string", multiple: true },
    "memo-type": { type: "string", multiple: true },
    "knowledge-type": { type: "string", multiple: true },
    tag: { type: "string", multiple: true },
    scope: { type: "string" },
    "content-type": { type: "string", multiple: true },
    before: { type: "string" },
    after: { type: "string" },
    limit: { type: "string" },
  },
  run: (ctx, positionals, values) => {
    const what = stringFlag(values, "what")
    if (!what) throw new UsageError("search requires --what (messages, memos, or attachments)")
    if (!(SEARCH_WHATS as readonly string[]).includes(what)) {
      throw new UsageError(`--what must be one of ${SEARCH_WHATS.join(", ")}, got "${what}"`)
    }
    const args: SearchArgs = { what: what as SearchWhat }
    const query = positionals[0]
    if (query !== undefined) args.query = query
    if (values.semantic === true) args.semantic = true
    if (values.exact === true) args.exact = true
    const streams = arrayFlag(values, "stream")
    if (streams) args.stream_ids = streams
    const type = arrayFlag(values, "type")
    if (type) args.type = type as SearchArgs["type"]
    const memoType = arrayFlag(values, "memo-type")
    if (memoType) args.memo_type = memoType as SearchArgs["memo_type"]
    const knowledgeType = arrayFlag(values, "knowledge-type")
    if (knowledgeType) args.knowledge_type = knowledgeType as SearchArgs["knowledge_type"]
    const tags = arrayFlag(values, "tag")
    if (tags) args.tags = tags
    const scope = stringFlag(values, "scope")
    if (scope) args.scope = scope as SearchArgs["scope"]
    const contentTypes = arrayFlag(values, "content-type")
    if (contentTypes) args.content_types = contentTypes as SearchArgs["content_types"]
    const before = stringFlag(values, "before")
    if (before) args.before = before
    const after = stringFlag(values, "after")
    if (after) args.after = after
    const limit = intFlag(values, "limit")
    if (limit !== undefined) args.limit = limit
    return search(ctx.client, ctx.resolver, args)
  },
  render: (payload) => {
    const p = payload as { data?: Array<Record<string, unknown>> }
    const rows = p.data ?? []
    if (rows.length === 0) return "(no results)"
    return rows
      .map((r) => {
        const id = r.id ?? (r.memo as { id?: string } | undefined)?.id ?? "?"
        return String(id)
      })
      .join("\n")
  },
}
