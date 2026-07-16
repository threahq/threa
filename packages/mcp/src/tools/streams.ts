import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { STREAM_TYPES } from "./constants"
import { buildQuery, runTool, type Envelope, type PagedEnvelope } from "./result"

export function registerStreamTools(server: McpServer, client: ThreaApiClient): void {
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
    async ({ type, query, after, limit }) =>
      runTool(() => client.get(`/streams${buildQuery({ type, query, after, limit })}`))
  )

  server.registerTool(
    "read_stream",
    {
      title: "Read a stream with its messages",
      description:
        "Fetch a stream and a page of its messages in one call (concurrent requests). Returns " +
        "{ stream, messages: { data, hasMore } } and, when `include_members` is true, " +
        "{ members: { data, hasMore, cursor } }. Message paging is by numeric message sequence, NOT a cursor: " +
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
      runTool(async () => {
        const id = encodeURIComponent(stream_id)
        const streamReq = client.get<Envelope<unknown>>(`/streams/${id}`)
        const messagesReq = client.get<PagedEnvelope<unknown>>(
          `/streams/${id}/messages${buildQuery({ before, after, limit })}`
        )
        const membersReq = include_members ? client.get<PagedEnvelope<unknown>>(`/streams/${id}/members`) : undefined

        const [streamResp, messagesResp, membersResp] = await Promise.all([
          streamReq,
          messagesReq,
          membersReq ?? Promise.resolve(undefined),
        ])

        const result: Record<string, unknown> = {
          stream: streamResp.data,
          messages: { data: messagesResp.data, hasMore: messagesResp.hasMore ?? false },
        }
        if (membersResp) {
          result.members = {
            data: membersResp.data,
            hasMore: membersResp.hasMore ?? false,
            cursor: membersResp.cursor ?? null,
          }
        }
        return result
      })
  )
}
