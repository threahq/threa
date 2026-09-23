import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { readConfigFile, wireLifecycle } from "@threahq/remote-session"
import { createHermesConnector } from "./connector"
import { installFromEnv, loadHermesConfig, writeCliConfig } from "./config"

async function main(): Promise<void> {
  const install = installFromEnv(process.env)
  const logPrefix = install.profile ? `[threa-hermes:${install.profile}]` : "[threa-hermes]"
  const result = loadHermesConfig({
    env: process.env,
    cwd: process.cwd(),
    hostname: hostname(),
    install,
    file: readConfigFile(install.configPath, (message) => process.stderr.write(`${logPrefix} ${message}\n`)),
  })
  if ("error" in result) {
    process.stderr.write(`${logPrefix} ${result.error}\n`)
    process.exit(1)
  }
  const config = result.config
  mkdirSync(install.workDir, { recursive: true, mode: 0o700 })

  // Hermes' own `threa` MCP server reads this file through THREA_CONFIG, so it
  // speaks as the same bot with the same workspace this connector is linked to.
  writeCliConfig(install.cliConfigPath, {
    apiKey: config.apiKey,
    workspaceId: config.workspaceId,
    baseUrl: config.baseUrl,
    keyScope: config.keyScope,
    ...(config.keyStore === undefined ? {} : { keyStore: config.keyStore }),
    ...(config.keyDir === undefined ? {} : { keyDir: config.keyDir }),
    instanceId: config.instanceId,
  })

  const connector = createHermesConnector(config, {
    log: (message) => process.stderr.write(`${logPrefix} ${message}\n`),
  })
  wireLifecycle(connector, process, { logPrefix })
  await connector.start()
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[threa-hermes] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
