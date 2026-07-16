import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { STREAM_TYPES } from "./constants"
import { buildQuery, runTool } from "./result"

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
    "get_stream",
    {
      title: "Get a stream",
      description: "Fetch one stream by id, including its type, name, visibility, and memory mode.",
      inputSchema: { stream_id: z.string() },
    },
    async ({ stream_id }) => runTool(() => client.get(`/streams/${encodeURIComponent(stream_id)}`))
  )

  server.registerTool(
    "list_stream_members",
    {
      title: "List stream members",
      description:
        "List the users who are members of a stream. Page by passing the previous response's `cursor` value " +
        "back as `cursor`; `hasMore` tells you when to stop. limit ≤ 200 (default 50).",
      inputSchema: {
        stream_id: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ stream_id, cursor, limit }) =>
      runTool(() =>
        client.get(`/streams/${encodeURIComponent(stream_id)}/members${buildQuery({ after: cursor, limit })}`)
      )
  )
}
