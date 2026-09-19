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

export const DEFAULT_HERMES_API_URL = "http://127.0.0.1:8642"

/**
 * A Hermes profile id, as `hermes profile create` accepts it, capped shorter:
 * the name goes into the derived instance id, and the 64-char id budget must
 * still fit the full hash that keeps two installs apart.
 */
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * Everything one connector install owns. A name selects a Hermes profile, and
 * every path this connector touches is named after it, so several agents run
 * side by side on one box without sharing a unit, a config, a work dir or a
 * scratchpad link. No name is the default profile at `~/.hermes`.
 */
export interface HermesInstall {
  profile?: string
  serviceName: string
  unitPath: string
  envFile: string
  configDir: string
  configPath: string
  workDir: string
  logDir: string
  cliConfigPath: string
  /** The profile's `HERMES_HOME`: where its persona and the `threa` skill live. */
  hermesHome: string
  /** Where the gateway serves this profile, unless the operator names another. */
  hermesApiUrl: string
  identity: ConnectorIdentity
  /**
   * Unset for the default install: it keeps reading the pre-keyring
   * `~/.threa/bik-hermes.json` it has always used. A named profile is new, so
   * it gets its own file rather than adopting another agent's key.
   */
  bikPath?: string
}

export function hermesInstall(input: { homeDir: string; profile?: string }): HermesInstall {
  const profile = input.profile?.trim()
  if (profile !== undefined && profile.length > 0 && !PROFILE_NAME.test(profile)) {
    throw new Error(
      `Invalid Hermes profile name ${JSON.stringify(profile)}: expected lowercase letters, digits, "-" or "_", ` +
        `starting with a letter or digit, at most 32 characters.`
    )
  }
  const named = profile !== undefined && profile.length > 0 ? profile : undefined
  const suffix = named ?? "remote"
  const configDir = join(input.homeDir, ".threa", `hermes-${suffix}`)
  const hermesHome = named ? join(input.homeDir, ".hermes", "profiles", named) : join(input.homeDir, ".hermes")
  const serviceName = `threa-hermes-${suffix}.service`
  return {
    ...(named === undefined ? {} : { profile: named }),
    serviceName,
    unitPath: join(input.homeDir, ".config", "systemd", "user", serviceName),
    envFile: join(input.homeDir, ".config", "threa", `hermes-${suffix}.env`),
    configDir,
    configPath: join(configDir, "config.json"),
    workDir: join(configDir, "work"),
    logDir: join(configDir, "log"),
    cliConfigPath: join(configDir, "threa-cli.json"),
    hermesHome,
    // A multiplexed gateway serves every secondary profile on the one listener
    // under /p/<profile>/, and 404s the prefix when it does not serve it — so a
    // named connector that reached the wrong agent fails instead of cross-talking.
    hermesApiUrl: named ? `${DEFAULT_HERMES_API_URL}/p/${named}` : DEFAULT_HERMES_API_URL,
    identity: {
      // hm/hms stable-id prefixes, so a Hermes connector never collides with a
      // Claude Code one in the same directory; the profile joins them because
      // two units share a WorkingDirectory and would otherwise derive one id.
      idPrefix: named ? `hm-${named}` : "hm",
      sessionIdPrefix: named ? `hms-${named}` : "hms",
      displayNamePrefix: named ? `Hermes ${named}` : "Hermes",
      configPathHint: join(configDir, "config.json"),
    },
    ...(named === undefined ? {} : { bikPath: join(configDir, "bik.json") }),
  }
}

/** The install this process serves, named by the unit that started it. */
export function installFromEnv(env: Record<string, string | undefined>): HermesInstall {
  const profile = env.THREA_HERMES_PROFILE
  return hermesInstall({ homeDir: homedir(), ...(profile === undefined ? {} : { profile }) })
}

export interface HermesApiConfig {
  apiUrl: string
  apiKey: string
}

export interface HermesRemoteConfig extends RemoteSessionConfig {
  hermes: HermesApiConfig
  install: HermesInstall
}

export type LoadHermesConfigResult = { config: HermesRemoteConfig } | { error: string }

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export interface HermesRawConfig extends RawConfig {
  hermesApiUrl?: unknown
  hermesApiKey?: unknown
}

export function loadHermesConfig(
  input: LoadConfigInput & { file?: HermesRawConfig; install: HermesInstall }
): LoadHermesConfigResult {
  const install = input.install
  const result = loadConfig(input, install.identity)
  if ("error" in result) return result

  const file = (input.file ?? {}) as HermesRawConfig
  const apiKey = str(input.env.HERMES_API_KEY) ?? str(file.hermesApiKey)
  if (!apiKey) {
    return {
      error: `Missing required config: HERMES_API_KEY. Set the env var or hermesApiKey in ${install.configPath}.`,
    }
  }
  const apiUrl = (str(input.env.HERMES_API_URL) ?? str(file.hermesApiUrl) ?? install.hermesApiUrl).replace(/\/$/, "")

  return {
    config: {
      ...result.config,
      localCwd: install.workDir,
      ...(result.config.bikPath === undefined && install.bikPath !== undefined ? { bikPath: install.bikPath } : {}),
      hermes: { apiUrl, apiKey },
      install,
    },
  }
}

export interface CliConfigInput {
  apiKey: string
  workspaceId: string
  baseUrl: string
  /** The connector's own key settings, so the MCP addresses the key this install advertised. */
  keyScope: RemoteSessionConfig["keyScope"]
  keyStore?: RemoteSessionConfig["keyStore"]
  keyDir?: string
  instanceId: string
}

/** The `THREA_CONFIG` file the Hermes-side `threa` MCP server reads; 0600 because it carries the bot key. */
export function writeCliConfig(path: string, input: CliConfigInput): void {
  writeFileAtomic(path, `${JSON.stringify({ ...input, principal: "bot" }, null, 2)}\n`)
}
