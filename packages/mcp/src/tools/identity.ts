import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ThreaApiClient } from "../api-client"
import type { ThreaMcpConfig } from "../config"
import { runTool } from "./result"

interface Principal {
  kind: string
  [key: string]: unknown
}

export function registerIdentityTools(server: McpServer, client: ThreaApiClient, config: ThreaMcpConfig): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return the authenticated principal for the configured API key (user or bot), the resolved API " +
        "version info, and the base URL and workspace this server is bound to. Use it to confirm the key " +
        "works and to discover your identity before other calls.",
    },
    async () =>
      runTool(async () => {
        const { data } = await client.get<{ data: Principal }>("/me")
        return { principal: data, baseUrl: config.baseUrl, workspaceId: config.workspaceId }
      })
  )
}
