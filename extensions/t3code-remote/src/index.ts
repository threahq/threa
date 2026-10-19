import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { readConfigFile, wireLifecycle } from "@threahq/remote-session"
import { T3Auth } from "./auth"
import { loadT3Config, loadT3Settings, t3Install, type T3RawConfig } from "./config"
import { createT3Connector } from "./connector"

const LOG_PREFIX = "[threa-t3code]"

function fail(message: string): never {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`)
  process.exit(1)
}

/** `threa-t3code login [code]`: exchange a pairing code (minted with the local `t3` CLI when omitted) for a saved token. */
async function login(code: string | undefined, file: T3RawConfig): Promise<void> {
  const install = t3Install()
  const result = loadT3Settings(process.env, file)
  if ("error" in result) fail(result.error)
  const { url, access } = result.settings
  await new T3Auth({ url, access, tokenPath: install.tokenPath, autoLogin: true }).login(code)
  process.stderr.write(
    `${LOG_PREFIX} logged in to T3 Code at ${url} (${access}); token saved to ${install.tokenPath}\n`
  )
}

async function main(): Promise<void> {
  const install = t3Install()
  const file: T3RawConfig =
    readConfigFile(install.configPath, (message) => process.stderr.write(`${LOG_PREFIX} ${message}\n`)) ?? {}
  const [command, ...args] = process.argv.slice(2)
  if (command === "login") return login(args[0], file)
  if (command !== undefined) fail(`Unknown command "${command}". Usage: threa-t3code [login [pairing-code]]`)

  // The identity and downloaded attachments both follow the cwd, so a manual run and the service share one scratchpad.
  mkdirSync(install.workDir, { recursive: true, mode: 0o700 })
  process.chdir(install.workDir)
  const result = loadT3Config({ env: process.env, cwd: install.workDir, hostname: hostname(), install, file })
  if ("error" in result) fail(result.error)
  const connector = createT3Connector(result.config, {
    log: (message) => process.stderr.write(`${LOG_PREFIX} ${message}\n`),
  })
  wireLifecycle(connector, process, { logPrefix: LOG_PREFIX })
  await connector.start()
}

if (import.meta.main) {
  main().catch((error) => fail(`fatal: ${error instanceof Error ? error.message : String(error)}`))
}
