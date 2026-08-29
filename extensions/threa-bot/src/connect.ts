import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_BASE_URL = "https://app.threa.io"

/** Where `threa-bot connect` stores the credentials `threa-bot run` reads when the environment has none. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.THREA_BOT_CONFIG || join(env.HOME || homedir(), ".threa", "bot.json")
}

export interface StoredBotConfig {
  baseUrl: string
  workspaceId: string
  workspaceName: string
  botId: string
  botSlug: string
  apiKey: string
}

export function readStoredConfig(path: string): StoredBotConfig | undefined {
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredBotConfig>
  if (typeof parsed.apiKey !== "string" || typeof parsed.workspaceId !== "string") {
    throw new Error(`${path} is not a threa-bot config (missing apiKey/workspaceId)`)
  }
  return parsed as StoredBotConfig
}

function writeStoredConfig(path: string, config: StoredBotConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

interface Started {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresAt: string
  intervalSeconds: number
}

type PollResult =
  | { status: "pending" | "denied" | "expired" | "claimed" }
  | {
      status: "approved"
      baseUrl: string
      workspaceId: string
      workspaceName: string
      botId: string
      botSlug: string
      apiKey: string
    }

export interface ConnectDeps {
  fetch: typeof fetch
  log: (line: string) => void
  print: (line: string) => void
  sleep: (ms: number) => Promise<void>
  configPath: string
  env: NodeJS.ProcessEnv
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let code = ""
    try {
      code = ((await response.json()) as { code?: string }).code ?? ""
    } catch {
      code = ""
    }
    throw new Error(`Threa API ${response.status}${code ? ` (${code})` : ""}`)
  }
  return (await response.json()) as T
}

/**
 * The device half of the connect flow: ask for a code pair, show the user
 * where to approve, poll until the browser has minted a bot key, store it.
 */
export async function runConnect(
  args: { baseUrl?: string; name?: string },
  deps: ConnectDeps
): Promise<StoredBotConfig> {
  const baseUrl = (args.baseUrl ?? deps.env.THREA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "")
  const started = await json<Started>(
    await deps.fetch(`${baseUrl}/api/bot-connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(args.name ? { name: args.name } : {}), host: hostname() }),
    })
  )
  deps.print(`Open ${started.verificationUrl}`)
  deps.print(`and confirm the code ${started.userCode} to connect this machine as a Threa bot.`)
  const deadline = new Date(started.expiresAt).getTime()
  while (Date.now() < deadline) {
    await deps.sleep(started.intervalSeconds * 1000)
    const result = await json<PollResult>(
      await deps.fetch(`${baseUrl}/api/bot-connect/poll?deviceCode=${encodeURIComponent(started.deviceCode)}`)
    )
    if (result.status === "pending") continue
    if (result.status !== "approved")
      throw new Error(`Connect request ${result.status}; run \`threa-bot connect\` again.`)
    const config: StoredBotConfig = {
      baseUrl: result.baseUrl,
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
      botId: result.botId,
      botSlug: result.botSlug,
      apiKey: result.apiKey,
    }
    writeStoredConfig(deps.configPath, config)
    deps.print(`Connected as @${config.botSlug} in ${config.workspaceName}. Credentials saved to ${deps.configPath}.`)
    deps.print(`Next: threa-bot run -- <your agent command>`)
    return config
  }
  throw new Error("The connect code expired before it was approved; run `threa-bot connect` again.")
}
