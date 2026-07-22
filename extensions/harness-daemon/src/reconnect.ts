import { basename } from "node:path"
import { findLocalPiPane, listLocalTmuxPanes, parsePiLaunch, type LocalTmuxPane, type PiLaunch } from "./discovery"
import { readInventoryReadonly } from "./inventory"
import { preflightRuntimeSession, type RuntimePreflightResult } from "./resume"
import { shellQuote } from "./shell"
import {
  configuredThreaBaseUrl,
  readPiRemoteConfig,
  readPiRemoteSession,
  type PiRemoteConfig,
  type PiRemoteSession,
} from "./spawners"
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

export interface ReconnectDeps {
  inventory: () => ManagedAgent[]
  panes: () => LocalTmuxPane[]
  piConfig: () => PiRemoteConfig
  piLink: (runtimeSessionId: string) => PiRemoteSession | undefined
  preflight: (params: Parameters<typeof preflightRuntimeSession>[0]) => Promise<RuntimePreflightResult>
  respawn: (target: string, cwd: string, command: string) => void
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

export function reconstructPiCommand(target: ReconnectTarget, runtimeSessionId: string): string {
  const environment = target.launch.environment.filter(
    ({ name }) => name !== "THREA_INSTANCE_ID" && name !== "THREA_RUNTIME_SESSION_ID"
  )
  environment.push(
    { name: "THREA_INSTANCE_ID", value: target.instanceId },
    { name: "THREA_RUNTIME_SESSION_ID", value: runtimeSessionId }
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

  deps.respawn(target.pane.paneId, target.pane.cwd, reconstructPiCommand(target, options.runtimeSessionId))
  console.log(`harnessd: reconnected Pi session ${options.runtimeSessionId} in ${target.pane.paneId}`)
}
