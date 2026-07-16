import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { CONVERSATION_STATUSES } from "./constants"
import { buildQuery, runTool } from "./result"

export function registerConversationTools(server: McpServer, client: ThreaApiClient): void {
  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description:
        "List conversations (grouped runs of messages under a stream's effective root), newest activity first. " +
        "Filter with `stream_id` (scopes to that stream's root and its threads) and `status` (active, stalled, " +
        "resolved). Page by passing the previous response's `cursor` value back as `cursor`; `hasMore` tells " +
        "you when to stop. limit ≤ 100 (default 50).",
      inputSchema: {
        stream_id: z.string().optional(),
        status: z.enum(CONVERSATION_STATUSES).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ stream_id, status, cursor, limit }) =>
      runTool(() => client.get(`/conversations${buildQuery({ streamId: stream_id, status, after: cursor, limit })}`))
  )

  server.registerTool(
    "get_conversation",
    {
      title: "Get a conversation",
      description: "Fetch one conversation by id, including its topic summary, status, and participant ids.",
      inputSchema: { conversation_id: z.string() },
    },
    async ({ conversation_id }) => runTool(() => client.get(`/conversations/${encodeURIComponent(conversation_id)}`))
  )

  server.registerTool(
    "get_conversation_messages",
    {
      title: "Get a conversation's messages",
      description:
        "List a conversation's member messages in chronological order. Messages may span the conversation's " +
        "root stream and its threads; each carries its own `streamId`. Page by passing the previous response's " +
        "`cursor` value back as `cursor`; `hasMore` tells you when to stop. limit ≤ 100 (default 50).",
      inputSchema: {
        conversation_id: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ conversation_id, cursor, limit }) =>
      runTool(() =>
        client.get(
          `/conversations/${encodeURIComponent(conversation_id)}/messages${buildQuery({ after: cursor, limit })}`
        )
      )
  )
}
