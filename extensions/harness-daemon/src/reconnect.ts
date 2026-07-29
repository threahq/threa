import { statSync } from "node:fs"
import { hostname } from "node:os"
import { basename, resolve } from "node:path"
import { readHarnessLinks, type HarnessLink } from "@threa/bot-runtime-client"
import { acceptClaudeBootPrompts, defaultClaudeBootDeps, type ClaudeBootDeps } from "./claude-boot"
import {
  defaultClaudeRegistryDeps,
  resolveClaudeNativeSession,
  type ClaudeNativeSession,
  type ClaudeRegistryDeps,
} from "./claude-registry"
import {
  attestedRuntimes,
  findLocalClaudeChannelPane,
  findLocalPiPane,
  listLocalTmuxPanes,
  resolveRuntimeIdentity,
  parseClaudeLaunch,
  parsePiLaunch,
  type ClaudeLaunch,
  type LocalTmuxPane,
  type PiLaunch,
} from "./discovery"
import { readMintedIdentities, type MintedIdentity } from "./identity-store"
import { readInventoryReadonly } from "./inventory"
import { preflightRuntimeSession, type RuntimePreflightResult } from "./resume"
import { shellQuote } from "./shell"
import {
  configuredThreaBaseUrl,
  readPiRemoteConfig,
  readPiRemoteSession,
  type PiRemoteConfig,
  readThreaChannelConfig,
  type PiRemoteSession,
} from "./spawners"
import type { ThreaChannelConfig } from "./types"
import { respawnPane } from "./tmux"
import type { ManagedAgent } from "./types"

export interface ReconnectOptions {
  runtimeSessionId: string
  rootStreamId: string
  force?: boolean
}

interface ReconnectTarget {
  pane: LocalTmuxPane
  launch: PiLaunch
  instanceId: string
}

interface ClaudeReconnectTarget {
  pane: LocalTmuxPane
  launch: ClaudeLaunch
  native: ClaudeNativeSession
  instanceId: string
}

export interface ReconnectDeps {
  inventory: () => ManagedAgent[]
  panes: () => LocalTmuxPane[]
  piConfig: () => PiRemoteConfig
  piLink: (runtimeSessionId: string) => PiRemoteSession | undefined
  preflight: (params: Parameters<typeof preflightRuntimeSession>[0]) => Promise<RuntimePreflightResult>
  respawn: (target: string, cwd: string, command: string) => void
  claudeConfig?: () => ThreaChannelConfig
  claudeRegistry?: ClaudeRegistryDeps
  links?: () => HarnessLink[]
  identities?: () => MintedIdentity[]
  mcpFile?: (path: string) => boolean
  sleep?: (ms: number) => Promise<void>
  claudeBoot?: Partial<ClaudeBootDeps>
}

export function defaultReconnectDeps(): ReconnectDeps {
  return {
    inventory: readInventoryReadonly,
    panes: listLocalTmuxPanes,
    piConfig: readPiRemoteConfig,
    piLink: readPiRemoteSession,
    preflight: preflightRuntimeSession,
    respawn: respawnPane,
  }
}

function samePaneGeneration(left: LocalTmuxPane, right: LocalTmuxPane): boolean {
  return (
    left.paneId === right.paneId &&
    left.panePid === right.panePid &&
    left.cwd === right.cwd &&
    left.startCommand === right.startCommand
  )
}

function resolveTarget(options: ReconnectOptions, deps: ReconnectDeps): ReconnectTarget {
  const managed = deps.inventory().filter((agent) => agent.runtimeSessionId === options.runtimeSessionId)
  let pane: LocalTmuxPane | undefined
  let agent: ManagedAgent | undefined
  if (managed.length > 0) {
    if (managed.length !== 1) throw new Error(`multiple managed agents match ${options.runtimeSessionId}`)
    const piAgents = managed.filter((candidate) => candidate.runtime === "pi")
    if (piAgents.length !== managed.length) throw new Error(`${options.runtimeSessionId} is not a Pi runtime session`)
    agent = piAgents[0]
    if (!agent?.tmuxPaneId) throw new Error(`managed Pi session ${options.runtimeSessionId} has no recorded pane`)
    const matches = deps.panes().filter((candidate) => candidate.paneId === agent!.tmuxPaneId)
    if (matches.length !== 1) throw new Error(`managed Pi pane ${agent.tmuxPaneId} is missing or ambiguous`)
    pane = matches[0]
  } else {
    pane = findLocalPiPane(options.runtimeSessionId, deps.panes())
    if (!pane) throw new Error(`no live Pi pane matched ${options.runtimeSessionId}`)
  }

  const launch = parsePiLaunch(pane.startCommand)
  if (!launch || launch.sessionId !== options.runtimeSessionId) {
    throw new Error(`pane ${pane.paneId} is not the exact Pi session ${options.runtimeSessionId}`)
  }
  const link = deps.piLink(options.runtimeSessionId)
  if (!link) throw new Error(`Pi remote link is missing or disabled for ${options.runtimeSessionId}`)
  if (link.rootStreamId !== options.rootStreamId) {
    throw new Error(`Pi remote root mismatch: expected ${options.rootStreamId}, got ${link.rootStreamId}`)
  }
  if (agent?.instanceId && agent.instanceId !== link.instanceId) {
    throw new Error(`managed Pi instance mismatch: expected ${agent.instanceId}, got ${link.instanceId}`)
  }
  const commandInstance = launch.environment.find(({ name }) => name === "THREA_INSTANCE_ID")?.value
  if (commandInstance && commandInstance !== link.instanceId) {
    throw new Error(`pane ${pane.paneId} has a different Threa instance identity`)
  }
  return { pane, launch, instanceId: link.instanceId }
}

export function reconstructPiCommand(target: ReconnectTarget, runtimeSessionId: string, rootStreamId: string): string {
  const environment = target.launch.environment.filter(
    ({ name }) =>
      name !== "THREA_INSTANCE_ID" && name !== "THREA_RUNTIME_SESSION_ID" && name !== "THREA_EXPECTED_ROOT_STREAM_ID"
  )
  environment.push(
    { name: "THREA_INSTANCE_ID", value: target.instanceId },
    { name: "THREA_RUNTIME_SESSION_ID", value: runtimeSessionId },
    { name: "THREA_EXPECTED_ROOT_STREAM_ID", value: rootStreamId }
  )
  return [
    "env",
    ...environment.map(({ name, value }) => `${name}=${value}`),
    target.launch.executable,
    "--session-id",
    runtimeSessionId,
  ]
    .map(shellQuote)
    .join(" ")
}

export async function reconnectPi(
  options: ReconnectOptions,
  deps: ReconnectDeps = defaultReconnectDeps()
): Promise<void> {
  const target = resolveTarget(options, deps)
  const config = deps.piConfig()
  const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
  const apiKey = process.env.THREA_API_KEY || config.apiKey
  if (!workspaceId || !apiKey) throw new Error("no Pi remote Threa credentials found")

  const result = await deps.preflight({
    baseUrl: configuredThreaBaseUrl(config),
    workspaceId,
    apiKey,
    runtimeKind: "pi-local",
    instanceId: target.instanceId,
    runtimeSessionId: options.runtimeSessionId,
    displayName: process.env.THREA_DISPLAY_NAME || config.defaultDisplayName || `Pi - ${basename(target.pane.cwd)}`,
    localCwd: target.pane.cwd,
    expectedRootStreamId: options.rootStreamId,
    labelName: process.env.THREA_DEFAULT_LABEL || config.defaultLabel || "coding",
  })
  if (result.status !== "linked") {
    const detail = result.status === "mismatch" ? `root mismatch: ${result.rootStreamId}` : result.reason
    throw new Error(`Pi reconnect preflight failed: ${detail}`)
  }

  const current = deps.panes().filter((pane) => pane.paneId === target.pane.paneId)
  if (current.length !== 1 || !samePaneGeneration(target.pane, current[0]!)) {
    throw new Error(`Pi pane ${target.pane.paneId} changed during reconnect preflight`)
  }
  const currentLaunch = parsePiLaunch(current[0]!.startCommand)
  if (!currentLaunch || currentLaunch.sessionId !== target.launch.sessionId) {
    throw new Error(`Pi session identity changed during reconnect preflight`)
  }
  const currentLink = deps.piLink(options.runtimeSessionId)
  if (
    !currentLink ||
    currentLink.instanceId !== target.instanceId ||
    currentLink.rootStreamId !== options.rootStreamId
  ) {
    throw new Error(`Pi remote link changed during reconnect preflight`)
  }

  deps.respawn(
    target.pane.paneId,
    target.pane.cwd,
    reconstructPiCommand(target, options.runtimeSessionId, options.rootStreamId)
  )
  console.log(`harnessd: reconnected Pi session ${options.runtimeSessionId} in ${target.pane.paneId}`)
}

function resolveClaudeTarget(options: ReconnectOptions, deps: ReconnectDeps): ClaudeReconnectTarget {
  const config = (deps.claudeConfig ?? readThreaChannelConfig)()
  const managed = deps.inventory().filter((agent) => agent.runtimeSessionId === options.runtimeSessionId)
  let pane: LocalTmuxPane | undefined
  let agent: ManagedAgent | undefined
  if (managed.length) {
    if (managed.length !== 1) throw new Error(`multiple managed agents match ${options.runtimeSessionId}`)
    agent = managed[0]
    if (agent.runtime !== "claude") throw new Error(`${options.runtimeSessionId} is not a Claude runtime session`)
    if (!agent.tmuxPaneId) throw new Error(`managed Claude session ${options.runtimeSessionId} has no recorded pane`)
    const matches = deps.panes().filter((candidate) => candidate.paneId === agent!.tmuxPaneId)
    if (matches.length !== 1) throw new Error(`managed Claude pane ${agent.tmuxPaneId} is missing or ambiguous`)
    pane = matches[0]
  } else {
    pane = findLocalClaudeChannelPane(
      options.runtimeSessionId,
      deps.panes(),
      config,
      hostname(),
      deps.links ?? readHarnessLinks,
      deps.identities ?? readMintedIdentities
    )
    if (!pane) throw new Error(`no live Claude pane matched ${options.runtimeSessionId}`)
  }
  const launch = parseClaudeLaunch(pane.startCommand)
  if (!launch) throw new Error(`pane ${pane.paneId} has an unsupported Claude launch`)
  const registryDeps = deps.claudeRegistry ?? defaultClaudeRegistryDeps()
  if (agent?.worktree) {
    let paneCwd: string
    let managedCwd: string
    try {
      paneCwd = registryDeps.canonical(pane.cwd)
      managedCwd = registryDeps.canonical(agent.worktree)
    } catch {
      throw new Error("managed Claude cwd is not canonicalizable")
    }
    if (paneCwd !== managedCwd) throw new Error("managed Claude cwd does not match pane")
  }
  // Same rungs, in the same order, the pane lookup just used. Re-deriving here
  // would reject the very pane the ledger identified: a session launched under
  // a different hostname derives a different id for life.
  const { instanceId, runtimeSessionId } = resolveRuntimeIdentity(
    pane.cwd,
    {
      declared: {
        instanceId: launch.environment.find(({ name }) => name === "THREA_INSTANCE_ID")?.value,
        runtimeSessionId: launch.environment.find(({ name }) => name === "THREA_RUNTIME_SESSION_ID")?.value,
      },
      identities: (deps.identities ?? readMintedIdentities)(),
      attested: attestedRuntimes((deps.links ?? readHarnessLinks)()),
    },
    config
  )
  if (!instanceId || !runtimeSessionId) throw new Error("Claude launch identity is empty after normalization")
  if (runtimeSessionId !== options.runtimeSessionId) throw new Error("Claude runtime identity mismatch")
  if (agent && (agent.runtimeSessionId !== runtimeSessionId || agent.instanceId !== instanceId)) {
    throw new Error("managed Claude identity does not match pane launch")
  }
  if (launch.mcpConfig) {
    launch.mcpConfig = resolve(pane.cwd, launch.mcpConfig)
    if (!(deps.mcpFile ?? ((path) => statSync(path).isFile()))(launch.mcpConfig)) {
      throw new Error(`Claude MCP config is not an existing regular file: ${launch.mcpConfig}`)
    }
  }
  const native = resolveClaudeNativeSession(pane.panePid, pane.cwd, launch.name, options.force ?? false, registryDeps)
  if (launch.resumeSessionId && launch.resumeSessionId !== native.sessionId) {
    throw new Error("Claude launch resume UUID does not match live registry session")
  }
  return { pane, launch, native, instanceId }
}

export function reconstructClaudeCommand(
  target: ClaudeReconnectTarget,
  runtimeSessionId: string,
  rootStreamId: string
): string {
  const pinned = new Set([
    "THREA_INSTANCE_ID",
    "THREA_RUNTIME_SESSION_ID",
    "THREA_COLD_START_IF_ARCHIVED",
    "THREA_COLD_START_IF_MISSING",
    "THREA_EXPECTED_ROOT_STREAM_ID",
  ])
  const words = [
    "env",
    ...target.launch.environment.filter(({ name }) => !pinned.has(name)).map(({ name, value }) => `${name}=${value}`),
    `THREA_INSTANCE_ID=${target.instanceId}`,
    `THREA_RUNTIME_SESSION_ID=${runtimeSessionId}`,
    "THREA_COLD_START_IF_ARCHIVED=wait",
    "THREA_COLD_START_IF_MISSING=error",
    `THREA_EXPECTED_ROOT_STREAM_ID=${rootStreamId}`,
    target.launch.executable,
    "--resume",
    target.native.sessionId,
  ]
  if (target.launch.name) words.push("--name", target.launch.name)
  if (target.launch.mcpConfig) words.push("--mcp-config", target.launch.mcpConfig)
  words.push("--dangerously-load-development-channels", `server:${target.launch.channel}`)
  if (target.launch.skipPermissions) words.push("--dangerously-skip-permissions")
  return words.map(shellQuote).join(" ")
}

export async function reconnectClaude(
  options: ReconnectOptions,
  deps: ReconnectDeps = defaultReconnectDeps()
): Promise<void> {
  const target = resolveClaudeTarget(options, deps)
  const config = (deps.claudeConfig ?? readThreaChannelConfig)()
  const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
  const apiKey = process.env.THREA_API_KEY || config.apiKey
  if (!workspaceId || !apiKey) throw new Error("no Claude channel Threa credentials found")
  const result = await deps.preflight({
    baseUrl: configuredThreaBaseUrl(config),
    workspaceId,
    apiKey,
    runtimeKind: "claude-code-channel",
    instanceId: target.instanceId,
    runtimeSessionId: options.runtimeSessionId,
    displayName: process.env.THREA_DISPLAY_NAME || config.displayName || `Claude Code - ${basename(target.pane.cwd)}`,
    localCwd: target.pane.cwd,
    expectedRootStreamId: options.rootStreamId,
    labelName: process.env.THREA_DEFAULT_LABEL || config.defaultLabel || "coding",
  })
  if (result.status !== "linked") {
    const detail = result.status === "mismatch" ? `root mismatch: ${result.rootStreamId}` : result.reason
    throw new Error(`Claude reconnect preflight failed: ${detail}`)
  }
  const current = deps.panes().filter((pane) => pane.paneId === target.pane.paneId)
  if (current.length !== 1 || !samePaneGeneration(target.pane, current[0]!)) {
    throw new Error(`Claude pane ${target.pane.paneId} changed during reconnect preflight`)
  }
  const launch = parseClaudeLaunch(current[0]!.startCommand)
  if (!launch) throw new Error("Claude launch changed during reconnect preflight")
  const native = resolveClaudeNativeSession(
    current[0]!.panePid,
    current[0]!.cwd,
    launch.name,
    options.force ?? false,
    deps.claudeRegistry ?? defaultClaudeRegistryDeps()
  )
  if (native.sessionId !== target.native.sessionId)
    throw new Error("Claude native session changed during reconnect preflight")
  if (launch.resumeSessionId && launch.resumeSessionId !== native.sessionId) {
    throw new Error("Claude launch resume UUID changed during reconnect preflight")
  }

  if (target.launch.mcpConfig && !(deps.mcpFile ?? ((path) => statSync(path).isFile()))(target.launch.mcpConfig)) {
    throw new Error(`Claude MCP config changed before respawn: ${target.launch.mcpConfig}`)
  }
  deps.respawn(
    target.pane.paneId,
    target.pane.cwd,
    reconstructClaudeCommand(target, options.runtimeSessionId, result.rootStreamId)
  )
  const sleep = deps.sleep ?? Bun.sleep
  const boot = { ...defaultClaudeBootDeps(), sleep, ...deps.claudeBoot }
  let booted = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250)
    const replacement = deps.panes().find((pane) => pane.paneId === target.pane.paneId)
    if (!replacement || replacement.panePid === target.pane.panePid || replacement.cwd !== target.pane.cwd) continue
    // The respawn faces the same boot dialogs a spawn does (the
    // development-channel warning above all), and clearing them can outlast
    // this loop's 20x250ms budget, so it happens before the native-session
    // check rather than after it.
    if (!booted) {
      await acceptClaudeBootPrompts(target.pane.paneId, boot)
      booted = true
    }
    try {
      const replacementNative = resolveClaudeNativeSession(
        replacement.panePid,
        replacement.cwd,
        target.launch.name,
        true,
        deps.claudeRegistry ?? defaultClaudeRegistryDeps()
      )
      if (replacementNative.sessionId === target.native.sessionId) {
        console.log(`harnessd: reconnected Claude session ${options.runtimeSessionId} in ${target.pane.paneId}`)
        return
      }
    } catch {}
  }
  throw new Error("Claude replacement did not verify the same native session and cwd")
}

export async function reconnectRuntime(
  options: ReconnectOptions,
  deps: ReconnectDeps = defaultReconnectDeps()
): Promise<void> {
  const exact = deps.inventory().filter((agent) => agent.runtimeSessionId === options.runtimeSessionId)
  if (exact.length > 1) throw new Error(`multiple managed agents match ${options.runtimeSessionId}`)
  if (exact[0]?.runtime === "pi") return reconnectPi(options, deps)
  if (exact[0]?.runtime === "claude") return reconnectClaude(options, deps)
  const panes = deps.panes()
  const piPane = findLocalPiPane(options.runtimeSessionId, panes)
  const claudePane = findLocalClaudeChannelPane(
    options.runtimeSessionId,
    panes,
    (deps.claudeConfig ?? readThreaChannelConfig)(),
    hostname(),
    deps.links ?? readHarnessLinks,
    deps.identities ?? readMintedIdentities
  )
  if (piPane && claudePane) throw new Error(`multiple live runtimes match ${options.runtimeSessionId}`)
  if (piPane) return reconnectPi(options, deps)
  if (claudePane) return reconnectClaude(options, deps)
  throw new Error(`no live runtime matched ${options.runtimeSessionId}`)
}
