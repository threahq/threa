import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ThreaApiClient } from "../api-client"
import type { ThreaConfig } from "../config"
import { assertPrincipal } from "../principal"
import { UsageError, type CommandSpec } from "../output"
import { createThreaMcpServer } from "../server"

export async function serveMcp(config: ThreaConfig): Promise<void> {
  await assertPrincipal(
    new ThreaApiClient({ baseUrl: config.baseUrl, workspaceId: config.workspaceId, apiKey: config.apiKey }),
    config
  )
  const server = createThreaMcpServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[threa] mcp serve connected; workspace ${config.workspaceId} at ${config.baseUrl}\n`)
}

export const mcpCommand: CommandSpec = {
  name: "mcp",
  summary: "Serve the same tools over MCP (`threa mcp serve`) on stdio",
  usage: "threa mcp serve",
  help:
    "threa mcp serve\n\n" +
    "Run the Threa MCP server over stdio, exposing the same workspace tools to an MCP client (e.g. Claude " +
    "Code). Register it with:\n" +
    "  claude mcp add threa --env THREA_API_KEY=... --env THREA_WORKSPACE_ID=... -- threa mcp serve\n\n" +
    "Flags:\n" +
    "  --help    show this help",
  options: {},
  serve: true,
  run: (_ctx, positionals) => {
    const sub = positionals[0]
    if (sub !== "serve") {
      throw new UsageError(`unknown mcp subcommand "${sub ?? ""}" — the only subcommand is "serve"`)
    }
    return Promise.resolve(undefined)
  },
}
