import { randomUUID } from "node:crypto"
import { readHarnessLinks, type HarnessLink } from "@threa/bot-runtime-client"
import { existsSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { acceptClaudeBootPrompts } from "./claude-boot"
import {
  defaultClaudeDiskDeps,
  findLiveClaudeSessions,
  resolveClaudeTranscript,
  type ClaudeDiskDeps,
} from "./claude-registry"
import { normalizeName, now } from "./cli"
import {
  findLocalClaudeChannelPane,
  listLocalTmuxPanes,
  parseClaudeChannelLaunch,
  type LocalTmuxPane,
} from "./discovery"
import { inventoryPath, readInventoryReadonly, upsertAgent } from "./inventory"
import { acquireProcessLock } from "./lock"
import {
  fetchScratchpadStatus,
  parseScratchpadUrl,
  preflightRuntimeSession,
  recordedNoYolo,
  type RuntimePreflightResult,
  type ScratchpadStatus,
} from "./resume"
import { commandPath, output } from "./shell"
import {
  claudeLaunchArgs,
  claudeLaunchCommand,
  configuredThreaBaseUrl,
  deriveClaudeRuntimeIdentity,
  mcpConfigPath,
  normalizeChannelMcpConfig,
  prepareClaudeChannel,
  readThreaChannelConfig,
  writeChannelMcpConfig,
} from "./spawners"
import { capturePane, createWindow, ensureTmuxSession, pickTmuxWindow, tmuxSession } from "./tmux"
import type { ManagedAgent, ThreaChannelConfig } from "./types"

/**
 * Bring a Claude channel session harnessd never launched under management.
 *
 * A hand-started session can have a perfectly valid deterministic identity, a
 * live scratchpad and a full transcript, and still be invisible to harnessd:
 * `reconnect` needs a live pane, `up` needs an inventory row, and a session
 * with neither falls between them the moment its process exits. Adoption is the
 * explicit, one-target bridge — never a sweep. Nothing here adopts by scanning
 * for local Claude directories, because a directory has never been evidence
 * that a session should run (see `up`'s 2026-07-20 incident note).
 */

export interface AdoptOptions {
  runtimeSessionId: string
  rootStreamId: string
  cwd?: string
  name?: string
  tmux?: string
  /** Pin the native conversation instead of taking the newest transcript in the cwd. */
  claudeSessionId?: string
  dryRun?: boolean
  /** Take over even though a Claude process is still running in the cwd without a pane. */
  force?: boolean
  noYolo?: boolean
}

export type AdoptStatus =
  | "adopted live"
  | "already managed"
  | "taken over"
  | "would adopt live"
  | "would take over"
  | "refused live without pane"
  | "refused ambiguous"
  | "refused identity mismatch"
  | "refused missing cwd"
  | "refused missing transcript"
  | "refused missing credentials"
  | "refused archived"
  | "refused inaccessible"
  | "refused unavailable"
  | "failed"

export interface AdoptOutcome {
  status: AdoptStatus
  detail?: string
}

export function adoptRefused(status: AdoptStatus): boolean {
  return status.startsWith("refused") || status === "failed"
}

export interface TakeoverLaunch {
  tmuxSession: string
  tmuxWindow: string
  tmuxWindowId: string
  tmuxPaneId: string
  output: string
}

export interface AdoptDeps {
  claudeConfig: () => ThreaChannelConfig
  inventory: () => ManagedAgent[]
  panes: () => LocalTmuxPane[]
  links: () => HarnessLink[]
  disk: ClaudeDiskDeps
  isDirectory: (path: string) => boolean
  scratchpadStatus: (params: {
    baseUrl: string
    workspaceId: string
    apiKey: string
    streamId: string
  }) => Promise<ScratchpadStatus>
  preflight: (params: Parameters<typeof preflightRuntimeSession>[0]) => Promise<RuntimePreflightResult>
  launch: (params: {
    name: string
    cwd: string
    tmux?: string
    resumeSessionId: string
    rootStreamId: string
    identity: { instanceId: string; runtimeSessionId: string }
    noYolo: boolean
  }) => Promise<TakeoverLaunch>
  persist: (agent: ManagedAgent) => void
  killWindow: (windowId: string) => void
  newId: () => string
}

export function defaultAdoptDeps(): AdoptDeps {
  return {
    claudeConfig: readThreaChannelConfig,
    inventory: readInventoryReadonly,
    panes: listLocalTmuxPanes,
    links: readHarnessLinks,
    disk: defaultClaudeDiskDeps(),
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    scratchpadStatus: fetchScratchpadStatus,
    preflight: preflightRuntimeSession,
    launch: launchTakeover,
    persist: upsertAgent,
    killWindow: (windowId) => {
      output(["tmux", "kill-window", "-t", windowId], { allowFailure: true })
    },
    newId: () => `claude-${Date.now()}-${randomUUID().slice(0, 8)}`,
  }
}

const STREAM_RE = /^stream_[A-Za-z0-9]+$/

/** Serialized against `up`/`reap` for the same reason they serialize against each other. */
export async function adoptClaudeSession(
  options: AdoptOptions,
  deps: AdoptDeps = defaultAdoptDeps()
): Promise<AdoptOutcome> {
  if (options.dryRun) return adoptClaudeSessionUnlocked(options, deps)
  const release = await acquireProcessLock(join(dirname(inventoryPath()), "resume-active.lock"))
  try {
    return await adoptClaudeSessionUnlocked(options, deps)
  } finally {
    release()
  }
}

export async function adoptClaudeSessionUnlocked(options: AdoptOptions, deps: AdoptDeps): Promise<AdoptOutcome> {
  if (!STREAM_RE.test(options.rootStreamId)) {
    return { status: "refused identity mismatch", detail: `not a root stream id: ${options.rootStreamId}` }
  }
  const config = deps.claudeConfig()
  const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
  const apiKey = process.env.THREA_API_KEY || config.apiKey
  if (!workspaceId || !apiKey) {
    return { status: "refused missing credentials", detail: "no Claude channel Threa credentials configured" }
  }
  const baseUrl = configuredThreaBaseUrl(config)

  // Inventory rows are immutable per launch, so several can legitimately record
  // one session. The newest is the row `latestAgents` and `findAgentOrUndefined`
  // would act on, and reusing its id is what keeps re-running adopt from adding
  // a row every time.
  const inventory = deps.inventory()
  const existing = inventory
    .filter((agent) => agent.runtimeSessionId === options.runtimeSessionId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  if (existing && existing.runtime !== "claude") {
    return {
      status: "refused identity mismatch",
      detail: `${existing.id} is recorded as a ${existing.runtime} session`,
    }
  }

  const link = deps.links().find((candidate) => candidate.runtimeSessionId === options.runtimeSessionId)
  if (link && link.runtimeKind !== "claude-code-channel" && link.runtimeKind !== "unknown") {
    return { status: "refused identity mismatch", detail: `harness link records runtime kind ${link.runtimeKind}` }
  }
  if (link && link.rootStreamId !== options.rootStreamId) {
    return {
      status: "refused identity mismatch",
      detail: `harness link binds ${options.runtimeSessionId} to ${link.rootStreamId}, not ${options.rootStreamId}`,
    }
  }

  let pane: LocalTmuxPane | undefined
  try {
    pane = findLocalClaudeChannelPane(options.runtimeSessionId, deps.panes(), config)
  } catch (error) {
    return { status: "refused ambiguous", detail: error instanceof Error ? error.message : String(error) }
  }

  const resolvedCwd = resolveCwd(options, { pane, link, existing }, deps)
  if ("status" in resolvedCwd) return resolvedCwd
  const cwd = resolvedCwd.cwd
  if (!deps.isDirectory(cwd)) {
    return { status: "refused missing cwd", detail: `${cwd} (${resolvedCwd.source}) is not an existing directory` }
  }

  // A session whose launch carried no THREA_* environment is only findable by
  // deriving from cwd, so the pane lookup above missed it whenever the derived
  // id is not the one being adopted (a hostname change is enough). The
  // directory's sole channel occupant is that pane — but only once something
  // else already attests this cwd belongs to the target session, which is
  // exactly what a link record or inventory row is.
  if (!pane && (link || existing)) {
    const occupants = deps
      .panes()
      .filter(
        (candidate) =>
          canonicalOrRaw(candidate.cwd, deps.disk) === cwd && parseClaudeChannelLaunch(candidate.startCommand)
      )
    if (occupants.length > 1) {
      return {
        status: "refused ambiguous",
        detail: `${occupants.length} Claude channel panes occupy ${cwd}: ${occupants.map((candidate) => candidate.paneId).join(", ")}`,
      }
    }
    const occupied = occupants[0]
    const declared = occupied && parseClaudeChannelLaunch(occupied.startCommand)?.runtimeSessionId
    if (occupied && declared && declared !== options.runtimeSessionId) {
      return {
        status: "refused identity mismatch",
        detail: `${occupied.paneId} in ${cwd} is running ${declared}, not ${options.runtimeSessionId}`,
      }
    }
    pane = occupied
  }

  // Identity has to be attested by something local. The cwd derivation is the
  // usual attestation, but it is not the only one: a session started under a
  // different hostname keeps its original id for life, and the link record the
  // runtime wrote is the stronger evidence in that case. What is refused is a
  // target NOTHING on this machine binds to this directory.
  const derived = deriveClaudeRuntimeIdentity(cwd, config)
  const launch = pane ? parseClaudeChannelLaunch(pane.startCommand) : undefined
  const attestations: Array<{ source: string; instanceId?: string }> = []
  if (link) attestations.push({ source: "harness link", instanceId: link.instanceId || undefined })
  if (existing) attestations.push({ source: "inventory", instanceId: existing.instanceId })
  if (launch?.runtimeSessionId === options.runtimeSessionId) {
    attestations.push({ source: "live launch", instanceId: launch.instanceId })
  }
  if (derived.runtimeSessionId === options.runtimeSessionId) {
    attestations.push({ source: "cwd", instanceId: derived.instanceId })
  }
  if (attestations.length === 0) {
    return {
      status: "refused identity mismatch",
      detail: `nothing binds ${options.runtimeSessionId} to ${cwd}: no harness link, no inventory row, no live launch, and the directory derives ${derived.runtimeSessionId}`,
    }
  }
  const claimed = attestations.filter((attestation): attestation is { source: string; instanceId: string } =>
    Boolean(attestation.instanceId)
  )
  const conflict = claimed.find((attestation) => attestation.instanceId !== claimed[0]!.instanceId)
  if (conflict) {
    return {
      status: "refused identity mismatch",
      detail: `instance id disagreement: ${claimed[0]!.source}=${claimed[0]!.instanceId}, ${conflict.source}=${conflict.instanceId}`,
    }
  }
  const instanceId = claimed[0]?.instanceId ?? derived.instanceId
  if (existing?.scratchpadUrl) {
    const recorded = parseScratchpadUrl(existing.scratchpadUrl)
    if (!recorded || recorded.streamId !== options.rootStreamId) {
      return {
        status: "refused identity mismatch",
        detail: `inventory records scratchpad ${existing.scratchpadUrl}, not ${options.rootStreamId}`,
      }
    }
    if (recorded.baseUrl !== baseUrl) {
      return {
        status: "refused identity mismatch",
        detail: "recorded scratchpad origin differs from configured base URL",
      }
    }
  }

  const name = normalizeName(options.name ?? existing?.name ?? basename(cwd))
  const clash = inventory.find((agent) => agent.name === name && agent.runtimeSessionId !== options.runtimeSessionId)
  if (clash) {
    return {
      status: "refused ambiguous",
      detail: `inventory already has an agent named ${name} (${clash.id}); pass --name`,
    }
  }

  if (!pane && !options.force) {
    const liveSessions = findLiveClaudeSessions(cwd, deps.disk)
    if (liveSessions.length > 0) {
      return {
        status: "refused live without pane",
        detail: `Claude is still running in ${cwd} (pid ${liveSessions.map((session) => session.pid).join(", ")}) with no tmux pane; kill it or pass --force`,
      }
    }
  }

  // Read-only: nothing on the server has been touched at this point, and
  // nothing will be if this refuses.
  const scratchpad = await deps.scratchpadStatus({ baseUrl, workspaceId, apiKey, streamId: options.rootStreamId })
  if (scratchpad !== "active") return { status: `refused ${scratchpad}`, detail: options.rootStreamId }

  const scratchpadUrl = existing?.scratchpadUrl ?? `${baseUrl}/w/${workspaceId}/s/${options.rootStreamId}`
  const identity = { instanceId, runtimeSessionId: options.runtimeSessionId }
  // Bypass follows the session being adopted, not harnessd's spawn default: the
  // live pane's own launch first, then what the row recorded.
  const observed = paneSkipsPermissions(pane)
  const noYolo = options.noYolo ?? (observed !== undefined ? !observed : existing ? recordedNoYolo(existing) : false)
  const command = adoptCommand(options, { name, cwd, noYolo })

  if (pane) {
    const alreadyManaged = Boolean(existing) && existing?.tmuxPaneId === pane.paneId && existing?.status === "online"
    if (options.dryRun) {
      return {
        status: alreadyManaged ? "already managed" : "would adopt live",
        detail: `${pane.sessionName}:${pane.windowName} (${pane.paneId}, pid ${pane.panePid})`,
      }
    }
    const preflight = await deps.preflight(
      preflightParams({ baseUrl, workspaceId, apiKey, config, identity, cwd, rootStreamId: options.rootStreamId })
    )
    if (preflight.status !== "linked") return preflightRefusal(preflight)
    deps.persist({
      id: existing?.id ?? deps.newId(),
      name,
      runtime: "claude",
      status: "online",
      worktree: cwd,
      branch: existing?.branch,
      tmuxSession: pane.sessionName,
      tmuxWindow: pane.windowName,
      tmuxWindowId: pane.windowId,
      tmuxPaneId: pane.paneId,
      scratchpadUrl,
      instanceId,
      runtimeSessionId: options.runtimeSessionId,
      command,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    })
    return {
      status: alreadyManaged ? "already managed" : "adopted live",
      detail: `${pane.sessionName}:${pane.windowName} (${pane.paneId}, pid ${pane.panePid})`,
    }
  }

  let transcript
  try {
    transcript = resolveClaudeTranscript(cwd, options.claudeSessionId, deps.disk)
  } catch (error) {
    return { status: "refused missing transcript", detail: error instanceof Error ? error.message : String(error) }
  }

  // Dry-run stops before the preflight for the same reason `up --dry-run` does:
  // that POST registers the session server-side.
  if (options.dryRun) {
    return { status: "would take over", detail: `${cwd} resuming ${transcript.sessionId}` }
  }

  const preflight = await deps.preflight(
    preflightParams({ baseUrl, workspaceId, apiKey, config, identity, cwd, rootStreamId: options.rootStreamId })
  )
  if (preflight.status !== "linked") return preflightRefusal(preflight)

  const record: ManagedAgent = {
    id: existing?.id ?? deps.newId(),
    name,
    runtime: "claude",
    status: "online",
    worktree: cwd,
    branch: existing?.branch,
    scratchpadUrl,
    instanceId,
    runtimeSessionId: options.runtimeSessionId,
    command,
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  }

  let launched: TakeoverLaunch
  try {
    launched = await deps.launch({
      name,
      cwd,
      tmux: options.tmux,
      resumeSessionId: transcript.sessionId,
      rootStreamId: preflight.rootStreamId,
      identity,
      noYolo,
    })
  } catch (error) {
    deps.persist({ ...record, status: "error", updatedAt: now(), lastOutput: String(error).slice(-4000) })
    return {
      status: "failed",
      detail: `takeover launch failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Same archive-during-launch TOCTOU `up` guards: a window whose scratchpad
  // went away mid-launch wedges and reads as "already running" forever.
  const recheck = await deps.scratchpadStatus({ baseUrl, workspaceId, apiKey, streamId: options.rootStreamId })
  if (recheck === "archived" || recheck === "inaccessible") {
    deps.killWindow(launched.tmuxWindowId)
    deps.persist({
      ...record,
      status: "error",
      updatedAt: now(),
      lastOutput: `scratchpad became ${recheck} during takeover; window killed`,
    })
    return { status: `refused ${recheck}`, detail: "scratchpad state changed during takeover; window killed" }
  }
  try {
    deps.persist({
      ...record,
      tmuxSession: launched.tmuxSession,
      tmuxWindow: launched.tmuxWindow,
      tmuxWindowId: launched.tmuxWindowId,
      tmuxPaneId: launched.tmuxPaneId,
      updatedAt: now(),
      lastOutput: launched.output.slice(-4000),
    })
  } catch (error) {
    deps.killWindow(launched.tmuxWindowId)
    return {
      status: "failed",
      detail: `inventory write failed after takeover; window killed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return {
    status: "taken over",
    detail: `${launched.tmuxSession}:${launched.tmuxWindow} resuming ${transcript.sessionId}, bypass ${noYolo ? "disabled" : "enabled"}`,
  }
}

function paneSkipsPermissions(pane: LocalTmuxPane | undefined): boolean | undefined {
  if (!pane) return undefined
  return parseClaudeChannelLaunch(pane.startCommand)?.skipPermissions
}

function adoptCommand(options: AdoptOptions, resolved: { name: string; cwd: string; noYolo: boolean }): string[] {
  const command = [
    "threa-harnessd",
    "adopt",
    options.runtimeSessionId,
    "--root-stream-id",
    options.rootStreamId,
    "--cwd",
    resolved.cwd,
    "--name",
    resolved.name,
  ]
  if (resolved.noYolo) command.push("--no-yolo")
  return command
}

function preflightParams(params: {
  baseUrl: string
  workspaceId: string
  apiKey: string
  config: ThreaChannelConfig
  identity: { instanceId: string; runtimeSessionId: string }
  cwd: string
  rootStreamId: string
}): Parameters<typeof preflightRuntimeSession>[0] {
  return {
    baseUrl: params.baseUrl,
    workspaceId: params.workspaceId,
    apiKey: params.apiKey,
    runtimeKind: "claude-code-channel",
    instanceId: params.identity.instanceId,
    runtimeSessionId: params.identity.runtimeSessionId,
    displayName:
      `${process.env.THREA_DISPLAY_NAME || params.config.displayName || "Claude Code"} - ${basename(params.cwd)}`.slice(
        0,
        100
      ),
    localCwd: params.cwd,
    expectedRootStreamId: params.rootStreamId,
    labelName: process.env.THREA_DEFAULT_LABEL || params.config.defaultLabel || "coding",
  }
}

function preflightRefusal(result: Exclude<RuntimePreflightResult, { status: "linked" }>): AdoptOutcome {
  if (result.status === "mismatch") {
    return {
      status: "refused identity mismatch",
      detail: `session preflight linked ${result.rootStreamId}, expected ${result.expectedRootStreamId}`,
    }
  }
  return { status: `refused ${result.status}`, detail: result.reason }
}

/**
 * Every source that claims to know the session's directory has to agree.
 * Disagreement is the shape of a mistyped `--cwd` or a stale link record, and
 * picking a winner silently would take over the wrong conversation.
 */
function resolveCwd(
  options: AdoptOptions,
  found: { pane?: LocalTmuxPane; link?: HarnessLink; existing?: ManagedAgent },
  deps: AdoptDeps
): { cwd: string; source: string } | AdoptOutcome {
  const candidates: Array<{ source: string; path: string }> = []
  if (options.cwd) candidates.push({ source: "--cwd", path: options.cwd })
  if (found.pane) candidates.push({ source: "live pane", path: found.pane.cwd })
  if (found.link) candidates.push({ source: "harness link", path: found.link.worktree })
  if (found.existing?.worktree) candidates.push({ source: "inventory", path: found.existing.worktree })
  if (candidates.length === 0) {
    return {
      status: "refused missing cwd",
      detail: "no --cwd, live pane, harness link, or inventory row names a working directory",
    }
  }
  const resolved = candidates.map(({ source, path }) => ({ source, path: canonicalOrRaw(path, deps.disk) }))
  const distinct = [...new Set(resolved.map(({ path }) => path))]
  if (distinct.length > 1) {
    return {
      status: "refused identity mismatch",
      detail: `sources disagree on the working directory: ${resolved.map(({ source, path }) => `${source}=${path}`).join(", ")}`,
    }
  }
  return { cwd: distinct[0]!, source: resolved[0]!.source }
}

function canonicalOrRaw(path: string, disk: ClaudeDiskDeps): string {
  try {
    return disk.canonical(path)
  } catch {
    return path
  }
}

/**
 * The real takeover launch: harnessd's supported Claude command and MCP wiring,
 * in a new window, resuming the recovered native conversation.
 */
async function launchTakeover(params: {
  name: string
  cwd: string
  tmux?: string
  resumeSessionId: string
  rootStreamId: string
  identity: { instanceId: string; runtimeSessionId: string }
  noYolo: boolean
}): Promise<TakeoverLaunch> {
  const claudeBin = process.env.THREA_HARNESSD_CLAUDE_BIN || commandPath("claude")
  if (!claudeBin) throw new Error("claude binary not found; set THREA_HARNESSD_CLAUDE_BIN or put claude on PATH")
  const channel = process.env.THREA_HARNESSD_CLAUDE_CHANNEL || "threa-channel"
  const channelEntry = prepareClaudeChannel()
  const mcpConfig = mcpConfigPath(params.name)
  if (!existsSync(mcpConfig)) writeChannelMcpConfig(params.name, channel, channelEntry)
  normalizeChannelMcpConfig(mcpConfig, channel, channelEntry)

  const session = params.tmux ?? tmuxSession({ runtime: "claude", name: params.name })
  ensureTmuxSession(session, true)
  const window = pickTmuxWindow(session, params.name)
  const { windowId, paneId } = createWindow(
    session,
    window,
    params.cwd,
    claudeLaunchCommand(
      claudeLaunchArgs({
        claudeBin,
        name: params.name,
        channel,
        mcpConfig,
        noYolo: params.noYolo,
        resumeSessionId: params.resumeSessionId,
      }),
      params.identity,
      readThreaChannelConfig(),
      "wait",
      "error",
      params.rootStreamId
    )
  )
  console.log(`harnessd: took over Claude Code in tmux ${session}:${window} (${windowId})`)
  try {
    await acceptClaudeBootPrompts(paneId)
    return {
      tmuxSession: session,
      tmuxWindow: window,
      tmuxWindowId: windowId,
      tmuxPaneId: paneId,
      output: capturePane(paneId),
    }
  } catch (error) {
    output(["tmux", "kill-window", "-t", windowId], { allowFailure: true })
    throw error
  }
}
