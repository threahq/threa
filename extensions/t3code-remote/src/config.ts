import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  loadConfig,
  type ConnectorIdentity,
  type LoadConfigInput,
  type RawConfig,
  type RemoteSessionConfig,
} from "@threahq/remote-session"

export const DEFAULT_T3_URL = "http://127.0.0.1:3773"

/** T3's permission ceilings, as its OAuth consent grants them; a launched thread runs at the token's. */
const T3_ACCESS_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const
export type T3Access = (typeof T3_ACCESS_MODES)[number]

export interface T3Install {
  configDir: string
  configPath: string
  workDir: string
  logDir: string
  tokenPath: string
  serviceName: string
  unitPath: string
  envFile: string
  identity: ConnectorIdentity
}

export function t3Install(homeDir: string = homedir()): T3Install {
  const configDir = join(homeDir, ".threa", "t3code-remote")
  const serviceName = "threa-t3code-remote.service"
  return {
    configDir,
    configPath: join(configDir, "config.json"),
    workDir: join(configDir, "work"),
    logDir: join(configDir, "log"),
    tokenPath: join(configDir, "token.json"),
    serviceName,
    unitPath: join(homeDir, ".config", "systemd", "user", serviceName),
    envFile: join(homeDir, ".config", "threa", "t3code-remote.env"),
    identity: {
      idPrefix: "t3",
      sessionIdPrefix: "t3s",
      displayNamePrefix: "T3 Code",
      configPathHint: join(configDir, "config.json"),
    },
  }
}

export interface T3Settings {
  url: string
  /** Threads launch into this T3 project; unset, each launches in its own scratch folder. */
  projectId?: string
  /** The OAuth consent ceiling a freshly minted token asks for. */
  access: T3Access
  /** Mint (and re-mint on a 401) the token through the local `t3` CLI instead of a manual `threa-t3code login`. */
  autoLogin: boolean
}

export interface T3RemoteConfig extends RemoteSessionConfig {
  t3: T3Settings
  install: T3Install
}

export interface T3RawConfig extends RawConfig {
  t3Url?: unknown
  t3ProjectId?: unknown
  t3Access?: unknown
  t3AutoLogin?: unknown
}

export type LoadT3ConfigResult = { config: T3RemoteConfig } | { error: string }

/** Unset is false; anything but a recognized yes or no is undefined, so a typo can't silently turn a setting off. */
function bool(value: unknown): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value ?? false
  const lowered = str(value)?.toLowerCase() ?? ""
  if (["1", "true", "yes", "on"].includes(lowered)) return true
  if (["0", "false", "no", "off"].includes(lowered)) return false
  return undefined
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/** A state file this connector wrote: absent is undefined, and a damaged one throws rather than reading as empty. */
export function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`Could not read ${path}: expected a JSON object`)
  return parsed as Record<string, unknown>
}

export function parseAccess(value: unknown): T3Access | undefined {
  const access = str(value)
  return T3_ACCESS_MODES.find((mode) => mode === access)
}

/** The T3 side of the config alone, which `threa-t3code login` needs before any Threa key exists. */
export function loadT3Settings(
  env: LoadConfigInput["env"],
  file: T3RawConfig = {}
): { settings: T3Settings } | { error: string } {
  const rawAccess = str(env.T3CODE_ACCESS) ?? str(file.t3Access)
  const access = rawAccess === undefined ? "full-access" : parseAccess(rawAccess)
  if (!access) return { error: `Invalid t3Access: expected one of ${T3_ACCESS_MODES.join(", ")}.` }
  const projectId = str(env.T3CODE_PROJECT_ID) ?? str(file.t3ProjectId)
  const autoLogin = bool(str(env.T3CODE_AUTO_LOGIN) ?? file.t3AutoLogin)
  if (autoLogin === undefined) return { error: "Invalid t3AutoLogin: expected true or false." }
  return {
    settings: {
      url: (str(env.T3CODE_URL) ?? str(file.t3Url) ?? DEFAULT_T3_URL).replace(/\/$/, ""),
      ...(projectId === undefined ? {} : { projectId }),
      access,
      autoLogin,
    },
  }
}

export function loadT3Config(input: LoadConfigInput & { file?: T3RawConfig; install: T3Install }): LoadT3ConfigResult {
  const { install } = input
  const result = loadConfig(input, install.identity)
  if ("error" in result) return result
  const t3 = loadT3Settings(input.env, input.file)
  if ("error" in t3) return t3
  return { config: { ...result.config, localCwd: install.workDir, t3: t3.settings, install } }
}
