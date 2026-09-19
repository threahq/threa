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
  // Where this channel's pre-keyring BIK was colocated with its config. The
  // keyring adopts that key rather than minting a fresh one, so the sealed
  // scratchpads an owner already wrapped to it keep opening.
  return {
    config: { ...result.config, localCwd: input.cwd, bikPath: result.config.bikPath ?? join(CONFIG_DIR, "bik.json") },
  }
}

export { parseConfigFile, type RawConfig, type RemoteSessionConfig } from "@threahq/remote-session"
