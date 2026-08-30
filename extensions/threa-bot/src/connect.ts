import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
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
  // Owner-only from the first byte, then swapped in whole: an existing file's
  // looser mode never applies to the new key, and a crash mid-write cannot
  // leave a truncated config behind.
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

/**
 * The key travels in the token response, so the origin must be TLS (RFC 8628
 * §3.1) — except a loopback address, which is where a developer runs the app.
 */
export function assertSecureBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not a URL: ${raw}`)
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${raw} must use https (plain http is only allowed for localhost)`)
  }
  return url.origin
}

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const CLIENT_ID = "threa-bot"

/** RFC 8628 §3.2. */
interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

/** RFC 8628 §3.5: a token, or one of the grant's error codes. */
type TokenResponse =
  | { error: string }
  | {
      access_token: string
      base_url: string
      workspace_id: string
      workspace_name: string
      bot_id: string
      bot_slug: string
    }

export interface ConnectDeps {
  fetch: typeof fetch
  log: (line: string) => void
  print: (line: string) => void
  sleep: (ms: number) => Promise<void>
  configPath: string
  env: NodeJS.ProcessEnv
}

async function postForm<T>(fetchImpl: typeof fetch, url: string, fields: Record<string, string>): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  })
  if (response.status === 429) throw new RateLimited()
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`Threa answered ${response.status} without a JSON body`)
  }
  // Token errors are 400s with an `error` code the caller reads; anything else is a failure.
  if (!response.ok && !(response.status === 400 && body && typeof body === "object" && "error" in body)) {
    throw new Error(`Threa API ${response.status}`)
  }
  return body as T
}

class RateLimited extends Error {
  constructor() {
    super("Threa is rate limiting this address; wait a minute and try again.")
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "The request was denied in Threa.",
  expired_token: "The code expired before it was approved.",
  invalid_grant: "The request is no longer valid.",
}

/**
 * The device half of the OAuth device authorization grant (RFC 8628): ask for
 * a code pair, show the user where to approve, poll the token endpoint until
 * the browser has minted a bot key, store it.
 */
export async function runConnect(
  args: { baseUrl?: string; name?: string },
  deps: ConnectDeps
): Promise<StoredBotConfig> {
  const baseUrl = assertSecureBaseUrl(args.baseUrl ?? deps.env.THREA_BASE_URL ?? DEFAULT_BASE_URL)
  const auth = await postForm<DeviceAuthorization>(deps.fetch, `${baseUrl}/api/oauth/device_authorization`, {
    client_id: CLIENT_ID,
    ...(args.name ? { name: args.name } : {}),
    host: hostname(),
  })
  deps.print(`Open ${auth.verification_uri_complete}`)
  deps.print(`and confirm the code ${auth.user_code} to connect this machine as a Threa bot.`)
  const deadline = Date.now() + auth.expires_in * 1000
  let intervalMs = auth.interval * 1000
  while (Date.now() < deadline) {
    await deps.sleep(intervalMs)
    let result: TokenResponse
    try {
      result = await postForm<TokenResponse>(deps.fetch, `${baseUrl}/api/oauth/token`, {
        grant_type: DEVICE_CODE_GRANT,
        device_code: auth.device_code,
        client_id: CLIENT_ID,
      })
    } catch (error) {
      // The edge rate limiter answers 429 before the grant does; RFC 8628 §3.5
      // spells the same instruction as `slow_down`.
      if (!(error instanceof RateLimited)) throw error
      result = { error: "slow_down" }
    }
    if ("error" in result) {
      if (result.error === "authorization_pending") continue
      if (result.error === "slow_down") {
        intervalMs += 5_000
        continue
      }
      throw new Error(
        `${ERROR_MESSAGES[result.error] ?? `Connect failed (${result.error}).`} Run \`threa-bot connect\` again.`
      )
    }
    const config: StoredBotConfig = {
      baseUrl: result.base_url,
      workspaceId: result.workspace_id,
      workspaceName: result.workspace_name,
      botId: result.bot_id,
      botSlug: result.bot_slug,
      apiKey: result.access_token,
    }
    writeStoredConfig(deps.configPath, config)
    deps.print(`Connected as @${config.botSlug} in ${config.workspaceName}. Credentials saved to ${deps.configPath}.`)
    deps.print(`Next: threa-bot run -- <your agent command>`)
    return config
  }
  throw new Error("The code expired before it was approved. Run `threa-bot connect` again.")
}
