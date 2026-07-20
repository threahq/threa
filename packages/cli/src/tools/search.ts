import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { search, SEARCH_WHATS, type SearchArgs } from "../ops"
import type { RefResolver } from "../resolver"
import { EXTRACTION_CONTENT_TYPES, KNOWLEDGE_TYPES, MEMO_SCOPES, MEMO_TYPES, STREAM_TYPES } from "./constants"
import { runTool } from "./result"

export function registerSearchTools(server: McpServer, client: ThreaApiClient, resolver: RefResolver): void {
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
        "- what: 'attachments' — search accessible attachments by filename or extracted content. query is " +
        "OPTIONAL — leave it empty to browse the most recent attachments. Filters: query, stream_ids, " +
        "content_types (chart, table, diagram, screenshot, photo, document, other), limit (≤50, default 20).\n" +
        "stream_ids maps to the API's source-stream scope; each entry accepts a stream_ id or `#channel-slug`. " +
        "For what='messages', result rows carry author { id, type, name, slug? }; message, attachment, and " +
        "conversation rows carry stream { id, name?, type? } and, for threads, rootStream. " +
        "Results are the search envelope { data: [...] }. For " +
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
    async (args) => runTool(() => search(client, resolver, args as SearchArgs))
  )
}
