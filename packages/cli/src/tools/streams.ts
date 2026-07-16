import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { listStreams, readStream } from "../ops"
import type { RefResolver } from "../resolver"
import { STREAM_TYPES } from "./constants"
import { runTool } from "./result"

export function registerStreamTools(server: McpServer, client: ThreaApiClient, resolver: RefResolver): void {
  server.registerTool(
    "list_streams",
    {
      title: "List streams",
      description:
        "List streams this key can access, newest-ish first. Filter with `type` (one or more of scratchpad, " +
        "channel, dm, thread, system) and `query` (text match on name). Page by passing the previous " +
        "response's `cursor` value back as `after`; `hasMore` tells you when to stop. limit ≤ 200 (default 50).",
      inputSchema: {
        type: z.array(z.enum(STREAM_TYPES)).optional(),
        query: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ type, query, after, limit }) => runTool(() => listStreams(client, { type, query, after, limit }))
  )

  server.registerTool(
    "read_stream",
    {
      title: "Read a stream with its messages",
      description:
        "Fetch a stream and a page of its messages in one call (concurrent requests). `stream_id` accepts a " +
        "stream_ id or a `#channel-slug` (an `@user-slug` DM ref is not resolvable — pass the DM's stream_ id). " +
        "Returns { stream, messages: { data, hasMore } } and, when `include_members` is true, " +
        "{ members: { data, hasMore, cursor } }. Message rows carry author { id, type, name, slug? } and members " +
        "carry name/slug, so author identity needs no follow-up. Message paging is by numeric message sequence, " +
        "NOT a cursor: " +
        "`before` returns messages before that sequence (older), `after` returns messages after it (newer); " +
        "pass at most one, and walk pages by taking the boundary message's `sequence`. limit ≤ 100 (default " +
        "50) applies to messages. If the stream cannot be read the whole call errors — no partial data is " +
        "returned.",
      inputSchema: {
        stream_id: z.string(),
        include_members: z.boolean().optional(),
        before: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ stream_id, include_members, before, after, limit }) =>
      runTool(() =>
        readStream(client, resolver, { streamId: stream_id, includeMembers: include_members, before, after, limit })
      )
  )
}
