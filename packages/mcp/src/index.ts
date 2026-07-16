#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config"
import { createThreaMcpServer } from "./server"

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }

  const server = createThreaMcpServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[threa-mcp] connected; workspace ${config.workspaceId} at ${config.baseUrl}\n`)
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[threa-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
