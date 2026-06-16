#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { ChannelServer } from "./channel-server"
import { CONFIG_PATH, loadConfig, parseConfigFile, type RawConfig } from "./config"
import { ThreaClient } from "./threa-client"

function readFileConfig(): RawConfig | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined
  try {
    return parseConfigFile(readFileSync(CONFIG_PATH, "utf8"))
  } catch (error) {
    process.stderr.write(
      `[threa-channel] ignoring ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return undefined
  }
}

async function main(): Promise<void> {
  const result = loadConfig({ env: process.env, cwd: process.cwd(), hostname: hostname(), file: readFileConfig() })
  if ("error" in result) {
    process.stderr.write(`[threa-channel] ${result.error}\n`)
    process.exit(1)
  }

  const client = new ThreaClient(result.config)
  const server = new ChannelServer(result.config, client)

  // Connect stdio first so Claude Code registers the channel and discovers the
  // reply tool even while the Threa bridge is still spinning up.
  await server.connectStdio()

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await server.shutdown().catch(() => undefined)
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  await server.start().catch((error) => {
    process.stderr.write(`[threa-channel] start failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
}

main().catch((error) => {
  process.stderr.write(`[threa-channel] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
