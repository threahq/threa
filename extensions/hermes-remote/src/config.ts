import { homedir } from "node:os"
import { join } from "node:path"
import {
  loadConfig,
  type ConnectorIdentity,
  type LoadConfigInput,
  type RawConfig,
  type RemoteSessionConfig,
  writeFileAtomic,
} from "@threahq/remote-session"

export const CONFIG_DIR = join(homedir(), ".threa", "hermes-remote")
export const CONFIG_PATH = join(CONFIG_DIR, "config.json")
export const WORK_DIR = join(CONFIG_DIR, "work")
export const CLI_CONFIG_PATH = join(CONFIG_DIR, "threa-cli.json")

export const DEFAULT_HERMES_API_URL = "http://127.0.0.1:8642"

/** hm/hms stable-id prefixes, so a Hermes connector never collides with a Claude Code one in the same directory. */
export const HERMES_CONNECTOR_IDENTITY: ConnectorIdentity = {
  idPrefix: "hm",
  sessionIdPrefix: "hms",
  displayNamePrefix: "Hermes",
  configPathHint: CONFIG_PATH,
}

export interface HermesApiConfig {
  apiUrl: string
  apiKey: string
}

export interface HermesRemoteConfig extends RemoteSessionConfig {
  hermes: HermesApiConfig
}

export type LoadHermesConfigResult = { config: HermesRemoteConfig } | { error: string }

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export interface HermesRawConfig extends RawConfig {
  hermesApiUrl?: unknown
  hermesApiKey?: unknown
}

export function loadHermesConfig(input: LoadConfigInput & { file?: HermesRawConfig }): LoadHermesConfigResult {
  const result = loadConfig(input, HERMES_CONNECTOR_IDENTITY)
  if ("error" in result) return result

  const file = (input.file ?? {}) as HermesRawConfig
  const apiKey = str(input.env.HERMES_API_KEY) ?? str(file.hermesApiKey)
  if (!apiKey) {
    return { error: `Missing required config: HERMES_API_KEY. Set the env var or hermesApiKey in ${CONFIG_PATH}.` }
  }
  const apiUrl = (str(input.env.HERMES_API_URL) ?? str(file.hermesApiUrl) ?? DEFAULT_HERMES_API_URL).replace(/\/$/, "")

  return {
    config: {
      ...result.config,
      localCwd: WORK_DIR,
      hermes: { apiUrl, apiKey },
    },
  }
}

export interface CliConfigInput {
  apiKey: string
  workspaceId: string
  baseUrl: string
}

/** The `THREA_CONFIG` file the Hermes-side `threa` MCP server reads; 0600 because it carries the bot key. */
export function writeCliConfig(path: string, input: CliConfigInput): void {
  writeFileAtomic(path, `${JSON.stringify({ ...input, principal: "bot" }, null, 2)}\n`)
}
