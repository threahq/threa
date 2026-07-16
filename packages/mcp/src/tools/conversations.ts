import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { enrichConversation, enrichMessages } from "../enrich"
import type { RefResolver } from "../resolver"
import { CONVERSATION_STATUSES } from "./constants"
import { buildQuery, runTool, type Envelope, type PagedEnvelope } from "./result"

export function registerConversationTools(server: McpServer, client: ThreaApiClient, resolver: RefResolver): void {
  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description:
        "List conversations (grouped runs of messages under a stream's effective root), newest activity first. " +
        "Filter with `stream_id` (accepts a stream_ id or `#channel-slug`; scopes to that stream's root and its " +
        "threads) and `status` (active, stalled, resolved). Each conversation mirrors its participantIds with a " +
        "participants array carrying name/slug. Page by passing the previous response's `cursor` value back as " +
        "`cursor`; `hasMore` tells you when to stop. limit ≤ 100 (default 50).",
      inputSchema: {
        stream_id: z.string().optional(),
        status: z.enum(CONVERSATION_STATUSES).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ stream_id, status, cursor, limit }) =>
      runTool(async () => {
        const streamId = stream_id ? await resolver.resolveStream(stream_id) : undefined
        const response = await client.get<PagedEnvelope<unknown>>(
          `/conversations${buildQuery({ streamId, status, after: cursor, limit })}`
        )
        const data = await Promise.all(response.data.map((c) => enrichConversation(c, resolver)))
        return { ...response, data }
      })
  )

  server.registerTool(
    "read_conversation",
    {
      title: "Read a conversation with its messages",
      description:
        "Fetch a conversation and a page of its member messages in one call (concurrent requests). Returns " +
        "{ conversation, messages: { data, hasMore, cursor } }. The conversation mirrors its participantIds with " +
        "a participants array (name/slug) and message rows carry author { id, type, name, slug? }. Messages are " +
        "chronological and may span the " +
        "conversation's root stream and its threads; each carries its own `streamId`. Page the messages by " +
        "passing the previous response's `cursor` value back as `cursor`; `hasMore` tells you when to stop. " +
        "limit ≤ 100 (default 50) applies to messages. If the conversation cannot be read the whole call " +
        "errors — no partial data is returned.",
      inputSchema: {
        conversation_id: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ conversation_id, cursor, limit }) =>
      runTool(async () => {
        const id = encodeURIComponent(conversation_id)
        const [conversationResp, messagesResp] = await Promise.all([
          client.get<Envelope<unknown>>(`/conversations/${id}`),
          client.get<PagedEnvelope<unknown>>(`/conversations/${id}/messages${buildQuery({ after: cursor, limit })}`),
        ])
        return {
          conversation: await enrichConversation(conversationResp.data, resolver),
          messages: {
            data: await enrichMessages(messagesResp.data, resolver),
            hasMore: messagesResp.hasMore ?? false,
            cursor: messagesResp.cursor ?? null,
          },
        }
      })
  )
}
