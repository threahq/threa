import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ThreaApiClient } from "./api-client"
import type { ThreaMcpConfig } from "./config"
import { RefResolver } from "./resolver"
import { registerAttachmentTools } from "./tools/attachments"
import { registerConversationTools } from "./tools/conversations"
import { registerDelegationTools } from "./tools/delegations"
import { registerIdentityTools } from "./tools/identity"
import { registerLabelTools } from "./tools/labels"
import { registerMemoTools } from "./tools/memos"
import { registerMessageTools } from "./tools/messages"
import { registerSearchTools } from "./tools/search"
import { registerStreamTools } from "./tools/streams"
import { registerUserTools } from "./tools/users"

const INSTRUCTIONS =
  "Threa MCP server. Wraps the Threa public REST API for one workspace, bound once from this server's " +
  "config — no tool takes a workspaceId. Authentication is a single API key. Tool results are JSON text in " +
  "the API's envelope: single resources under `data`, lists as { data, hasMore, cursor? } (feed `cursor` back " +
  "as the paging arg to continue); " +
  "failures come back as isError results carrying { code, message, hint? }. A 404 can mean the resource " +
  "does not exist or that the key lacks the required scope. Identifier args accept a raw id or a " +
  "sigil-prefixed slug: a stream arg takes a stream_ id or `#channel-slug` (your DM with a user by `@user-slug` " +
  "is not resolvable — the public API hides a DM's counterpart, so pass the DM's stream_ id), and user args " +
  "take a usr_/bot_ id or `@user-slug` (bots and personas are not queryable by slug). An unresolved ref fails " +
  "before any call with code UNRESOLVED_REF. Payloads are self-descriptive: message rows carry " +
  "author { id, type, name, slug? }, conversation participantIds are mirrored by a participants array with " +
  "name/slug, and stream members carry name/slug — so you rarely need a follow-up lookup. Start with `whoami` " +
  "to confirm the key and " +
  "identity. Read tools: list_streams and read_stream (one call returns a stream plus a page of its messages " +
  "by numeric sequence, and its members when include_members is set), list_users, list_conversations and " +
  "read_conversation (a conversation plus a page of its messages), and find_messages_by_metadata (exact " +
  "reference lookup). Search: one `search` tool with what = messages | memos | attachments — memos is GAM " +
  "(the knowledge extracted from this workspace's conversations), search it before asking a human; each " +
  "`what` accepts only its own filters. Write tools: send_message (markdown; optional conversation resume via " +
  "conversation_id or a new one via start_conversation; auto client_message_id for idempotent retries), " +
  "update_message / delete_message (only messages this key sent), and list_labels / apply_label / remove_label " +
  "(labels are private to the key actor and found-or-created by name). Memory provenance: get_memo traces a " +
  "memo to its source messages. Attachments: get_attachment (metadata plus extracted text), " +
  "get_attachment_download_url (short-lived signed URL for the raw bytes). Delegations: close the loop on a " +
  "delegated task with list_delegations (the open queue) → claim_delegation (returns a claim token shown once " +
  "and stored in memory for this session; 15-min TTL) → update_delegation while working (status_note reports " +
  "progress and renews the claim, no note is a pure heartbeat) → finish_delegation (outcome complete or fail). " +
  "A completed result is posted into the delegation's stream so GAM memorizes it. Lifecycle tools reuse the " +
  "stored token; pass claim_token to override or to recover after a server restart. request_delegation_access " +
  "is bot-key only."

export function createThreaMcpServer(config: ThreaMcpConfig): McpServer {
  const server = new McpServer({ name: "threa", version: "0.1.0" }, { instructions: INSTRUCTIONS })
  const client = new ThreaApiClient({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    apiKey: config.apiKey,
  })
  const resolver = new RefResolver({ client })

  registerIdentityTools(server, client, config)
  registerStreamTools(server, client, resolver)
  registerUserTools(server, client)
  registerMessageTools(server, client, resolver)
  registerSearchTools(server, client, resolver)
  registerConversationTools(server, client, resolver)
  registerLabelTools(server, client, resolver)
  registerMemoTools(server, client)
  registerAttachmentTools(server, client)
  registerDelegationTools(server, client)

  return server
}
