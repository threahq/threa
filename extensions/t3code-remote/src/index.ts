import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { BotSupervisorTransport } from "@threahq/harness-client"
import { readConfigFile, ThreaClient, wireLifecycle } from "@threahq/remote-session"
import { T3Auth } from "./auth"
import { loadT3Config, loadT3Settings, t3Install, type T3RawConfig, type T3RemoteConfig } from "./config"
import { createT3Connector } from "./connector"
import { Hibernation, hibernationDir, systemctlUser } from "./hibernation"
import { createWaker } from "./waker"

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

const WAKE_RECONNECT_MS = 60_000

/** `threa-t3code wake`: the one resident process while connectors hibernate, starting each again when it is wanted. */
function wake(config: T3RemoteConfig): void {
  const log = (message: string) => process.stderr.write(`${LOG_PREFIX} ${message}\n`)
  const client = new ThreaClient(config)
  const hibernation = new Hibernation(hibernationDir(), systemctlUser)
  const waker = createWaker({
    hibernating: () => hibernation.list(),
    isArchived: async (rootStreamId) => Boolean(await client.getStreamArchivedAt(rootStreamId)),
    start: (unit) => systemctlUser(["start", unit]),
    log,
  })
  const transport = new BotSupervisorTransport({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    apiKey: config.apiKey,
    onReady: () => void waker.sweep(),
    onSessionRestored: (payload) => waker.nudge(payload.runtimeSessionId),
    onInvocationAvailable: (payload) => waker.nudge(payload.runtimeSessionId),
    log,
  })
  // A refused or failed connect drops the socket; connecting again is a no-op while one is up.
  const reconnect = setInterval(() => void transport.connect(), WAKE_RECONNECT_MS)
  wireLifecycle(
    {
      shutdown: async () => {
        clearInterval(reconnect)
        transport.disconnect()
      },
    },
    process,
    { logPrefix: LOG_PREFIX }
  )
  log(`waking hibernating connectors (${hibernation.list().length} now) from ${hibernationDir()}`)
  void transport.connect()
}

async function main(): Promise<void> {
  const install = t3Install()
  const file: T3RawConfig =
    readConfigFile(install.configPath, (message) => process.stderr.write(`${LOG_PREFIX} ${message}\n`)) ?? {}
  const [command, ...args] = process.argv.slice(2)
  if (command === "login") return login(args[0], file)
  if (command !== undefined && command !== "wake") {
    fail(`Unknown command "${command}". Usage: threa-t3code [login [pairing-code] | wake]`)
  }

  // The identity and downloaded attachments both follow the cwd, so a manual run and the service share one scratchpad.
  mkdirSync(install.workDir, { recursive: true, mode: 0o700 })
  process.chdir(install.workDir)
  const result = loadT3Config({ env: process.env, cwd: install.workDir, hostname: hostname(), install, file })
  if ("error" in result) fail(result.error)
  if (command === "wake") return wake(result.config)
  const connector = createT3Connector(result.config, {
    log: (message) => process.stderr.write(`${LOG_PREFIX} ${message}\n`),
  })
  wireLifecycle(connector, process, { logPrefix: LOG_PREFIX })
  await connector.start()
}

if (import.meta.main) {
  main().catch((error) => fail(`fatal: ${error instanceof Error ? error.message : String(error)}`))
}
