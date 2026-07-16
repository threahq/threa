import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { EXTRACTION_CONTENT_TYPES, KNOWLEDGE_TYPES, MEMO_SCOPES, MEMO_TYPES, STREAM_TYPES } from "./constants"
import { runTool, toolError } from "./result"

const SEARCH_WHATS = ["messages", "memos", "attachments"] as const
type SearchWhat = (typeof SEARCH_WHATS)[number]

const ALLOWED_FILTERS: Record<SearchWhat, readonly string[]> = {
  messages: ["query", "semantic", "exact", "stream_ids", "type", "before", "after", "limit"],
  memos: ["query", "exact", "stream_ids", "memo_type", "knowledge_type", "tags", "scope", "before", "after", "limit"],
  attachments: ["query", "stream_ids", "content_types", "limit"],
}

const FILTER_KEYS = [
  "query",
  "semantic",
  "exact",
  "stream_ids",
  "type",
  "memo_type",
  "knowledge_type",
  "tags",
  "scope",
  "content_types",
  "before",
  "after",
  "limit",
] as const

export function registerSearchTools(server: McpServer, client: ThreaApiClient): void {
  server.registerTool(
    "search",
    {
      title: "Search the workspace",
      description:
        "One search across the workspace, routed by `what`. Only the filters listed for the chosen `what` are " +
        "accepted; passing any other filter is an error that names the offending arg.\n" +
        "- what: 'messages' — full-text search over messages in accessible streams. Filters: query (required), " +
        "`semantic: true` for meaning-based vector retrieval when you know the idea but not the words, " +
        "`exact: true` to match the query as a literal phrase, stream_ids, type (stream types), before/after " +
        "(ISO-8601 datetimes), limit (≤50, default 20).\n" +
        "- what: 'memos' — search GAM (the knowledge extracted from this workspace's conversations: decisions, " +
        "learnings, procedures, context, references). Search this BEFORE asking a human. query is meaning-based " +
        "and OPTIONAL — leave it empty to browse the most recent memos. Filters: query, `exact: true` (or wrap " +
        "the query in double quotes) to match a literal phrase, stream_ids, memo_type (message vs. conversation " +
        "source), knowledge_type, tags, scope (user = private to this key's user, stream, workspace), " +
        "before/after (ISO-8601 datetimes), limit (≤100, default 20).\n" +
        "- what: 'attachments' — search accessible attachments by filename or extracted content. Filters: query " +
        "(required), stream_ids, content_types (chart, table, diagram, screenshot, photo, document, other), " +
        "limit (≤50, default 20).\n" +
        "stream_ids maps to the API's source-stream scope. Results are the search envelope { data: [...] }. For " +
        "exact metadata lookup use find_messages_by_metadata; for a memo's source provenance use get_memo.",
      inputSchema: {
        what: z.enum(SEARCH_WHATS),
        query: z.string().optional(),
        semantic: z.boolean().optional(),
        exact: z.boolean().optional(),
        stream_ids: z.array(z.string()).optional(),
        type: z.array(z.enum(STREAM_TYPES)).optional(),
        memo_type: z.array(z.enum(MEMO_TYPES)).optional(),
        knowledge_type: z.array(z.enum(KNOWLEDGE_TYPES)).optional(),
        tags: z.array(z.string()).optional(),
        scope: z.enum(MEMO_SCOPES).optional(),
        content_types: z.array(z.enum(EXTRACTION_CONTENT_TYPES)).optional(),
        before: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const { what } = args
      const allowed = ALLOWED_FILTERS[what]
      const raw = args as Record<string, unknown>
      const offending = FILTER_KEYS.filter((key) => raw[key] !== undefined && !allowed.includes(key))
      if (offending.length > 0) {
        const validList = allowed.filter((f) => f !== "query" && f !== "limit").join(", ")
        return toolError(
          "UNSUPPORTED_FILTER",
          `search what="${what}" does not support: ${offending.join(", ")}. ` +
            `Valid filters for "${what}": ${validList || "none"} (plus query, limit).`
        )
      }

      const query = args.query
      if ((what === "messages" || what === "attachments") && (query === undefined || query.trim() === "")) {
        return toolError(
          "INVALID_ARGUMENT",
          `search what="${what}" requires a non-empty query. Only what="memos" allows an empty query (recent-first browse).`
        )
      }

      if (what !== "memos" && args.limit !== undefined && args.limit > 50) {
        return toolError(
          "INVALID_ARGUMENT",
          `search what="${what}" caps limit at 50 (only what="memos" allows up to 100).`
        )
      }

      if (what === "messages") {
        return runTool(() =>
          client.post("/messages/search", {
            query,
            semantic: args.semantic,
            exact: args.exact,
            streams: args.stream_ids,
            type: args.type,
            before: args.before,
            after: args.after,
            limit: args.limit,
          })
        )
      }
      if (what === "memos") {
        return runTool(() =>
          client.post("/memos/search", {
            query,
            exact: args.exact,
            streams: args.stream_ids,
            memoType: args.memo_type,
            knowledgeType: args.knowledge_type,
            tags: args.tags,
            scope: args.scope,
            before: args.before,
            after: args.after,
            limit: args.limit,
          })
        )
      }
      return runTool(() =>
        client.post("/attachments/search", {
          query,
          streams: args.stream_ids,
          contentTypes: args.content_types,
          limit: args.limit,
        })
      )
    }
  )
}
