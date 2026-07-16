import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { STREAM_TYPES } from "./constants"
import { buildQuery, runTool } from "./result"

export function registerMessageTools(server: McpServer, client: ThreaApiClient): void {
  server.registerTool(
    "get_messages",
    {
      title: "Get messages in a stream",
      description:
        "Read a stream's messages in sequence order. Paging is by numeric message sequence, NOT a cursor: " +
        "`before` returns messages before that sequence (older), `after` returns messages after it (newer); " +
        "pass at most one. The response envelope is { data, hasMore } with no cursor field, so walk pages by " +
        "taking the boundary message's `sequence`. limit ≤ 100 (default 50).",
      inputSchema: {
        stream_id: z.string(),
        before: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ stream_id, before, after, limit }) =>
      runTool(() =>
        client.get(`/streams/${encodeURIComponent(stream_id)}/messages${buildQuery({ before, after, limit })}`)
      )
  )

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Search messages across accessible streams. Choose the retrieval mode: default is full-text keyword " +
        "search; set `semantic: true` for meaning-based (vector) retrieval when you know the idea but not the " +
        "words; set `exact: true` to match the query as a literal phrase. Scope with `stream_ids` (specific " +
        "stream ids) and `type` (stream types). Bound by time with `before`/`after` as ISO-8601 datetimes. " +
        "limit ≤ 50 (default 20). To look messages up by stamped external references instead of text, use " +
        "find_messages_by_metadata.",
      inputSchema: {
        query: z.string().min(1),
        semantic: z.boolean().optional(),
        exact: z.boolean().optional(),
        stream_ids: z.array(z.string()).optional(),
        type: z.array(z.enum(STREAM_TYPES)).optional(),
        before: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, semantic, exact, stream_ids, type, before, after, limit }) =>
      runTool(() =>
        client.post("/messages/search", {
          query,
          semantic,
          exact,
          streams: stream_ids,
          type,
          before,
          after,
          limit,
        })
      )
  )

  server.registerTool(
    "find_messages_by_metadata",
    {
      title: "Find messages by metadata",
      description:
        "Find non-deleted messages whose `metadata` contains every given key/value pair (exact AND-containment, " +
        "not text search). Use this for dedup and lookup by external reference you stamped at send time, e.g. " +
        '{ "github.pr": "org/repo#42" } to check whether a message was already posted for that PR. Narrow ' +
        "with `stream_id`. limit ≤ 100 (default 20).",
      inputSchema: {
        metadata: z.record(z.string(), z.string()),
        stream_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ metadata, stream_id, limit }) =>
      runTool(() => client.post("/messages/find-by-metadata", { metadata, streamId: stream_id, limit }))
  )
}
