#!/usr/bin/env bun
import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { readConfigFile, wireLifecycle } from "@threahq/remote-session"
import { createHermesConnector } from "./connector"
import { CLI_CONFIG_PATH, CONFIG_PATH, WORK_DIR, loadHermesConfig, writeCliConfig } from "./config"

const LOG_PREFIX = "[threa-hermes]"

async function main(): Promise<void> {
  const result = loadHermesConfig({
    env: process.env,
    cwd: process.cwd(),
    hostname: hostname(),
    file: readConfigFile(CONFIG_PATH, (message) => process.stderr.write(`${LOG_PREFIX} ${message}\n`)),
  })
  if ("error" in result) {
    process.stderr.write(`${LOG_PREFIX} ${result.error}\n`)
    process.exit(1)
  }
  const config = result.config
  mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 })

  // Hermes' own `threa` MCP server reads this file through THREA_CONFIG, so it
  // speaks as the same bot with the same workspace this connector is linked to.
  writeCliConfig(CLI_CONFIG_PATH, {
    apiKey: config.apiKey,
    workspaceId: config.workspaceId,
    baseUrl: config.baseUrl,
  })

  const connector = createHermesConnector(config, {
    log: (message) => process.stderr.write(`${LOG_PREFIX} ${message}\n`),
  })
  wireLifecycle(connector, process, { logPrefix: LOG_PREFIX })
  await connector.start()
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${LOG_PREFIX} fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
