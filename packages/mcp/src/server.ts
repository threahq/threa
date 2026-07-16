import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ThreaApiClient } from "./api-client"
import type { ThreaMcpConfig } from "./config"
import { registerIdentityTools } from "./tools/identity"

const INSTRUCTIONS =
  "Threa MCP server. Wraps the Threa public REST API for one workspace, bound once from this server's " +
  "config — no tool takes a workspaceId. Authentication is a single API key. Tool results are JSON text; " +
  "failures come back as isError results carrying { code, message, hint? }. A 404 can mean the resource " +
  "does not exist or that the key lacks the required scope. Start with `whoami` to confirm the key and " +
  "identity."

export function createThreaMcpServer(config: ThreaMcpConfig): McpServer {
  const server = new McpServer({ name: "threa", version: "0.1.0" }, { instructions: INSTRUCTIONS })
  const client = new ThreaApiClient({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    apiKey: config.apiKey,
  })

  registerIdentityTools(server, client, config)

  return server
}
