import { homedir } from "node:os"
import { join } from "node:path"
import {
  loadConfig,
  type ConnectorIdentity,
  type LoadConfigInput,
  type LoadConfigResult,
} from "@threahq/remote-session"

export const CONFIG_DIR = join(homedir(), ".claude", "threa-channel")
export const CONFIG_PATH = join(CONFIG_DIR, "config.json")

/** cc/ccs stable-id prefixes: the same project directory always maps back to the same Claude Code scratchpad. */
export const CLAUDE_CONNECTOR_IDENTITY: ConnectorIdentity = {
  idPrefix: "cc",
  sessionIdPrefix: "ccs",
  displayNamePrefix: "Claude Code",
  configPathHint: CONFIG_PATH,
}

export function loadChannelConfig(input: LoadConfigInput): LoadConfigResult {
  const result = loadConfig(input, CLAUDE_CONNECTOR_IDENTITY)
  if ("error" in result) return result
  // Colocate the channel's BIK (its sealed-scratchpad identity key) with its
  // config, unless the user pointed it elsewhere (THREA_BIK_PATH / file bikPath).
  return { config: { ...result.config, bikPath: result.config.bikPath ?? join(CONFIG_DIR, "bik.json") } }
}

export { parseConfigFile, type RawConfig, type RemoteSessionConfig } from "@threahq/remote-session"
