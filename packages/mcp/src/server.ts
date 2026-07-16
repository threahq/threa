import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ThreaApiClient } from "./api-client"
import type { ThreaMcpConfig } from "./config"
import { registerConversationTools } from "./tools/conversations"
import { registerIdentityTools } from "./tools/identity"
import { registerMessageTools } from "./tools/messages"
import { registerStreamTools } from "./tools/streams"
import { registerUserTools } from "./tools/users"

const INSTRUCTIONS =
  "Threa MCP server. Wraps the Threa public REST API for one workspace, bound once from this server's " +
  "config — no tool takes a workspaceId. Authentication is a single API key. Tool results are JSON text; " +
  "failures come back as isError results carrying { code, message, hint? }. A 404 can mean the resource " +
  "does not exist or that the key lacks the required scope. Start with `whoami` to confirm the key and " +
  "identity. Read tools: list_streams / get_stream / list_stream_members, list_users, get_messages " +
  "(numeric-sequence paging), search_messages (full-text, semantic, or exact), find_messages_by_metadata " +
  "(exact reference lookup), and list_conversations / get_conversation / get_conversation_messages."

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

  return server
}
