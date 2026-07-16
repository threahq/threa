import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ThreaApiClient } from "./api-client"
import type { ThreaMcpConfig } from "./config"
import { registerAttachmentTools } from "./tools/attachments"
import { registerConversationTools } from "./tools/conversations"
import { registerIdentityTools } from "./tools/identity"
import { registerLabelTools } from "./tools/labels"
import { registerMemoTools } from "./tools/memos"
import { registerMessageTools } from "./tools/messages"
import { registerStreamTools } from "./tools/streams"
import { registerUserTools } from "./tools/users"

const INSTRUCTIONS =
  "Threa MCP server. Wraps the Threa public REST API for one workspace, bound once from this server's " +
  "config — no tool takes a workspaceId. Authentication is a single API key. Tool results are JSON text in " +
  "the API's envelope: single resources under `data`, lists as { data, hasMore, cursor? } (feed `cursor` back " +
  "as the paging arg to continue); " +
  "failures come back as isError results carrying { code, message, hint? }. A 404 can mean the resource " +
  "does not exist or that the key lacks the required scope. Start with `whoami` to confirm the key and " +
  "identity. Read tools: list_streams / get_stream / list_stream_members, list_users, get_messages " +
  "(numeric-sequence paging), search_messages (full-text, semantic, or exact), find_messages_by_metadata " +
  "(exact reference lookup), and list_conversations / get_conversation / get_conversation_messages. Write " +
  "tools: send_message (markdown; optional conversation resume via conversation_id or a new one via " +
  "start_conversation; auto client_message_id for idempotent retries), update_message / delete_message " +
  "(only messages this key sent), and list_labels / apply_label / remove_label (labels are private to the " +
  "key actor and found-or-created by name). Memory: search_memos searches GAM (the knowledge extracted from " +
  "this workspace's conversations) — search it before asking a human — and get_memo traces a memo to its " +
  "source messages. Attachments: search_attachments (by filename or extracted content), get_attachment " +
  "(metadata plus extracted text), get_attachment_download_url (short-lived signed URL for the raw bytes)."

export function createThreaMcpServer(config: ThreaMcpConfig): McpServer {
  const server = new McpServer({ name: "threa", version: "0.1.0" }, { instructions: INSTRUCTIONS })
  const client = new ThreaApiClient({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    apiKey: config.apiKey,
  })

  registerIdentityTools(server, client, config)
  registerStreamTools(server, client)
  registerUserTools(server, client)
  registerMessageTools(server, client)
  registerConversationTools(server, client)
  registerLabelTools(server, client)
  registerMemoTools(server, client)
  registerAttachmentTools(server, client)

  return server
}
