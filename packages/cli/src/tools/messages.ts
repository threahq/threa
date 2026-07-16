import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { findMessagesByMetadata } from "../ops"
import type { RefResolver } from "../resolver"
import { runTool, toolError } from "./result"

export function registerMessageTools(server: McpServer, client: ThreaApiClient, resolver: RefResolver): void {
  server.registerTool(
    "send_message",
    {
      title: "Send a message to a stream",
      description:
        "Post a markdown message to a stream. `stream_id` accepts a stream_ id or a `#channel-slug` (an " +
        "`@user-slug` DM ref is not resolvable — pass the DM's stream_ id). Content is markdown: mentions are `[@slug](user:usr_x)` / " +
        "`[@slug](persona:persona_x)` / `[#slug](channel:stream_x)`, and plain URLs unfurl into link previews. " +
        "Conversation control: pass `conversation_id` to append to an existing conversation (it must live under " +
        "the same root stream as the target, else the API returns 400 CONVERSATION_NOT_IN_ROOT), or set " +
        "`start_conversation: true` to open a fresh conversation; setting both is an error. Idempotency: a " +
        "`client_message_id` is auto-generated (`mcp-<uuid>`) when you omit one so a retried call never " +
        "double-posts — the effective id is returned as `clientMessageId`. `metadata` is a flat string→string " +
        "map (≤20 keys, no `threa.` key prefix) stamped on the message for later lookup via " +
        "find_messages_by_metadata. The result carries the created message plus `conversationId` when a " +
        "conversation directive was applied.",
      inputSchema: {
        stream_id: z.string(),
        content: z.string().min(1),
        client_message_id: z.string().max(128).optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        conversation_id: z.string().optional(),
        start_conversation: z.boolean().optional(),
      },
    },
    async ({ stream_id, content, client_message_id, metadata, conversation_id, start_conversation }) => {
      if (conversation_id && start_conversation) {
        return toolError(
          "INVALID_ARGUMENT",
          "Pass either conversation_id (resume an existing conversation) or start_conversation (open a new one), not both."
        )
      }
      const clientMessageId = client_message_id ?? `mcp-${crypto.randomUUID()}`
      const body: Record<string, unknown> = { content, clientMessageId }
      if (metadata) body.metadata = metadata
      if (conversation_id) body.conversation = { intent: "existing", conversationId: conversation_id }
      else if (start_conversation) body.conversation = { intent: "new" }
      return runTool(async () => {
        const streamId = await resolver.resolveStream(stream_id)
        const response = await client.post<{ data: unknown; conversationId?: string }>(
          `/streams/${encodeURIComponent(streamId)}/messages`,
          body
        )
        return { ...response, clientMessageId }
      })
    }
  )

  server.registerTool(
    "update_message",
    {
      title: "Edit a message",
      description:
        "Replace a message's content with new markdown. Only works on messages this API key sent — the API " +
        "rejects edits to any other author's message. Returns the updated message.",
      inputSchema: {
        message_id: z.string(),
        content: z.string().min(1),
      },
    },
    async ({ message_id, content }) =>
      runTool(() => client.patch(`/messages/${encodeURIComponent(message_id)}`, { content }))
  )

  server.registerTool(
    "delete_message",
    {
      title: "Delete a message",
      description:
        "Delete a message. Only works on messages this API key sent — the API rejects deletes of any other " +
        "author's message. Returns { deleted: true, message_id } on success.",
      inputSchema: {
        message_id: z.string(),
      },
    },
    async ({ message_id }) =>
      runTool(async () => {
        await client.delete(`/messages/${encodeURIComponent(message_id)}`)
        return { deleted: true, message_id }
      })
  )

  server.registerTool(
    "find_messages_by_metadata",
    {
      title: "Find messages by metadata",
      description:
        "Find non-deleted messages whose `metadata` contains every given key/value pair (exact AND-containment, " +
        "not text search). Use this for dedup and lookup by external reference you stamped at send time, e.g. " +
        '{ "github.pr": "org/repo#42" } to check whether a message was already posted for that PR. Narrow ' +
        "with `stream_id` (accepts a stream_ id or `#channel-slug`). limit ≤ 100 (default 20). Message rows " +
        "carry author { id, type, name, slug? }.",
      inputSchema: {
        metadata: z.record(z.string(), z.string()),
        stream_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ metadata, stream_id, limit }) =>
      runTool(() => findMessagesByMetadata(client, resolver, { metadata, streamRef: stream_id, limit }))
  )
}
