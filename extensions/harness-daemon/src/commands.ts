import { randomUUID } from "node:crypto"
import {
  BotSupervisorTransport,
  readHarnessLinks,
  type BotSessionRestoredPayload,
  type HarnessLink,
} from "@threa/bot-runtime-client"
import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import { backfillIdentities, defaultBackfillDeps, summarizeBackfill, type BackfillOutcome } from "./backfill"
import { installBootResume } from "./boot"
import { liveClaudePidsIn } from "./claude-registry"
import { defaultRepo, inferBranch, normalizeName, now } from "./cli"
import {
  findLocalClaudeChannelPane,
  listLocalTmuxPanes,
  resolveManagedAgentPane,
  type LocalTmuxPane,
  type ManagedAgentPane,
  type ResolvedRuntimeIdentity,
} from "./discovery"
import { die } from "./errors"
import { identityConsistency, identityVerdict } from "./identity"
import {
  findAgent,
  findAgentOrUndefined,
  inventoryPath,
  readInventory,
  readInventoryReadonly,
  upsertAgent,
} from "./inventory"
import { acquireProcessLock, resumeActiveLockPath } from "./lock"
import { commandExists, commandPath, output } from "./shell"
import {
  ClaudeRuntimeSpawner,
  PiRuntimeSpawner,
  RuntimeSpawnError,
  claudeAgentIdentity,
  configuredThreaBaseUrl,
  deriveClaudeRuntimeIdentity,
  readPiRemoteConfig,
  readPiRemoteSession,
  readThreaChannelConfig,
  type PiRemoteConfig,
  type PiRemoteSession,
} from "./spawners"
import {
  fetchScratchpadStatus,
  latestAgentsByIdentity,
  parseScratchpadUrl,
  preflightRuntimeSession,
  probeSuppressed,
  recordedNoYolo,
  withProbeBackoff,
  withoutProbeBackoff,
  type RuntimePreflightResult,
  type ScratchpadStatus,
} from "./resume"
import { attachedTmuxSession, ensureTmuxSession, sendKeys } from "./tmux"
import type { ManagedAgent, ResumeOptions, SpawnOptions, SpawnResult, ThreaChannelConfig } from "./types"
import { defaultReapDeps, reapArchivedWorktrees } from "./reap"
import { defaultTombstoneDeps, summarizeTombstones, tombstoneAbandonedRows, type TombstoneOutcome } from "./tombstone"
import { restorableWorktreeSource, restoreManagedWorktree } from "./worktree"
import { runWatchLoop, unavailableBackoffMs, uniqueSupervisorTargets, watchIntervalMs } from "./watch"

export function restoredSessionMatches(
  candidate: { rootStreamId: string; instanceId?: string; runtimeSessionId?: string },
  target: BotSessionRestoredPayload
): boolean {
  return (
    candidate.rootStreamId === target.rootStreamId &&
    candidate.instanceId === target.instanceId &&
    candidate.runtimeSessionId === target.runtimeSessionId
  )
}

function spawnCommand(options: SpawnOptions): string[] {
  const command = ["threa-harnessd", "spawn", options.runtime, "--name", options.name]
  if (options.branch) command.push("--branch", options.branch)
  if (options.base) command.push("--base", options.base)
  if (options.repo) command.push("--repo", options.repo)
  if (options.tmux) command.push("--tmux", options.tmux)
  if (options.skipSetup) command.push("--skip-setup")
  if (options.noRemote) command.push("--no-remote")
  if (options.noRegister) command.push("--no-register")
  if (options.noAutoAccept) command.push("--no-auto-accept")
  if (options.noYolo) command.push("--no-yolo")
  return command
}

export async function spawnAgent(options: SpawnOptions): Promise<void> {
  const command = spawnCommand(options)
  const id = `${options.runtime}-${Date.now()}-${randomUUID().slice(0, 8)}`
  const createdAt = now()
  const agent = {
    id,
    name: options.name,
    runtime: options.runtime,
    status: "starting" as const,
    branch: options.branch,
    tmuxSession: options.tmux,
    command,
    createdAt,
    updatedAt: createdAt,
  }
  upsertAgent(agent)

  const spawner = options.runtime === "pi" ? new PiRuntimeSpawner() : new ClaudeRuntimeSpawner()
  try {
    const result = await spawner.spawn(options)
    upsertAgent({
      ...agent,
      worktree: result.worktree,
      branch: result.branch,
      tmuxSession: result.tmuxSession,
      tmuxWindow: result.tmuxWindow,
      tmuxWindowId: result.tmuxWindowId,
      tmuxPaneId: result.tmuxPaneId,
      scratchpadUrl: result.scratchpadUrl,
      instanceId: result.instanceId,
      runtimeSessionId: result.runtimeSessionId,
      status: "online",
      updatedAt: now(),
      lastOutput: result.output.slice(-4000),
    })
    if (result.output) process.stdout.write(result.output)
    console.log(`harnessd: recorded ${id}`)
  } catch (error) {
    const { output: _output, ...partial } = error instanceof RuntimeSpawnError ? error.partial : {}
    upsertAgent({
      ...agent,
      ...partial,
      status: "error",
      updatedAt: now(),
      lastOutput: String(error).slice(-4000),
    })
    throw error
  }
}

/** The first Threa target the local configs and environment agree on, for a pass that must talk to the server. */
function threaTarget(purpose: string): { baseUrl: string; workspaceId: string; apiKey: string } {
  const targetFor = (config: { baseUrl?: string; workspaceId?: string; apiKey?: string }) => {
    const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
    const apiKey = process.env.THREA_API_KEY || config.apiKey
    if (!workspaceId || !apiKey) return undefined
    return { baseUrl: configuredThreaBaseUrl(config), workspaceId, apiKey }
  }
  const [target] = uniqueSupervisorTargets([targetFor(readThreaChannelConfig()), targetFor(readPiRemoteConfig())])
  if (!target) throw new Error(`harnessd: no Threa credentials found for ${purpose}`)
  return target
}

/** Long enough for an ordinary revive or reap to finish, short enough that a wedged holder cannot delay startup. */
export const STARTUP_LOCK_WAIT_MS = 30_000

export interface StartupReconciliationDeps {
  backfill: () => BackfillOutcome[]
  /** Runs after the backfill on the same pass: the backfill records identity, tombstoning uses it. */
  tombstone: () => Promise<TombstoneOutcome[]>
  /** Resolves to the release. A dry run resolves to a no-op, as every other dry-run path does. */
  lock: () => Promise<() => void>
  sweep: () => void | Promise<void>
  log: (message: string) => void
}

export function defaultStartupReconciliationDeps(
  sweep: () => void | Promise<void>,
  dryRun: boolean,
  lockWaitMs = STARTUP_LOCK_WAIT_MS
): StartupReconciliationDeps {
  return {
    backfill: () => backfillIdentities(defaultBackfillDeps(), dryRun),
    tombstone: () => tombstoneAbandonedRows(defaultTombstoneDeps(threaTarget("the tombstone pass")), dryRun),
    // Bounded: the default deadline is ten minutes, and until this resolves no
    // transport exists and no reap runs. The backfill is an optimisation of what
    // the resolver already computes, so losing a pass costs nothing — the next
    // restart runs it again.
    lock: async () => (dryRun ? () => {} : await acquireProcessLock(resumeActiveLockPath(), { timeoutMs: lockWaitMs })),
    sweep,
    log: (message) => console.warn(message),
  }
}

/**
 * Record the identities the stores already agree on, then sweep.
 *
 * The lock is released before the sweep: `acquireProcessLock` is not reentrant —
 * a lock file naming the current pid is neither stolen nor rejected, it is
 * waited on until the 10-minute timeout — and the sweep takes the same lock.
 *
 * A failing backfill is logged and the sweep still runs: the backfill is an
 * optimisation of what the resolver already computes, never a precondition for
 * reviving a session.
 */
export async function startupReconciliation(deps: StartupReconciliationDeps): Promise<void> {
  let release: (() => void) | undefined
  try {
    // Inside the try: a lock whose holder is alive is neither stolen nor
    // rejected, it is waited on and then throws, and this runs on a path whose
    // failure must not stop the daemon starting.
    release = await deps.lock()
    const outcomes = deps.backfill()
    const counts = summarizeBackfill(outcomes)
      .map(([disposition, count]) => `${count} ${disposition}`)
      .join(", ")
    deps.log(`harnessd: identity backfill: ${outcomes.length} subject(s)${counts ? `, ${counts}` : ""}`)
  } catch (error) {
    deps.log(`harnessd: identity backfill failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    release?.()
  }

  await deps.sweep()

  // AFTER the sweep, deliberately. Tombstoning is the only half that talks to
  // the network — one request per worktree-gone row, serially — and nothing the
  // sweep does depends on its result, since a row a tombstone could retire is
  // already refused by the revive path's own status gate. Ahead of the sweep it
  // delayed every boot revival by the length of that round trip.
  try {
    const release = await deps.lock()
    try {
      const tombstones = await deps.tombstone()
      const counts = summarizeTombstones(tombstones)
        .map(([disposition, count]) => `${count} ${disposition}`)
        .join(", ")
      deps.log(`harnessd: tombstone: ${tombstones.length} row(s)${counts ? `, ${counts}` : ""}`)
    } finally {
      release()
    }
  } catch (error) {
    deps.log(`harnessd: tombstone pass failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function backfillIdentitiesCommand(options: { dryRun: boolean }): Promise<void> {
  // Same lock as the revive and reap passes, and skipped for a dry run exactly
  // as they skip it: unlocked, the reaper can retire an identity while this pass
  // is recording it.
  const release = options.dryRun ? () => {} : await acquireProcessLock(resumeActiveLockPath())
  let outcomes
  try {
    outcomes = backfillIdentities(defaultBackfillDeps(), options.dryRun)
  } finally {
    release()
  }
  for (const outcome of outcomes) {
    console.log(`${outcome.disposition}\t${outcome.subject}${outcome.detail ? `\t${outcome.detail}` : ""}`)
  }
  const counts = summarizeBackfill(outcomes)
    .map(([disposition, count]) => `${count} ${disposition}`)
    .join(", ")
  console.log(`harnessd: ${outcomes.length} subject${outcomes.length === 1 ? "" : "s"}${counts ? `, ${counts}` : ""}`)
}

export async function tombstoneCommand(options: { dryRun: boolean }): Promise<void> {
  const deps = defaultTombstoneDeps(threaTarget("the tombstone pass"))
  // Same lock as the revive, reap and backfill passes, and skipped for a dry run
  // exactly as they skip it.
  const release = options.dryRun ? () => {} : await acquireProcessLock(resumeActiveLockPath())
  let outcomes
  try {
    outcomes = await tombstoneAbandonedRows(deps, options.dryRun)
  } finally {
    release()
  }
  for (const outcome of outcomes) {
    console.log(`${outcome.disposition}\t${outcome.subject}${outcome.detail ? `\t${outcome.detail}` : ""}`)
  }
  const counts = summarizeTombstones(outcomes)
    .map(([disposition, count]) => `${count} ${disposition}`)
    .join(", ")
  console.log(`harnessd: ${outcomes.length} row${outcomes.length === 1 ? "" : "s"}${counts ? `, ${counts}` : ""}`)
}

export async function watchUnarchived(options: ResumeOptions): Promise<void> {
  const watchStartedAtMs = Date.now()
  const session = options.tmux ?? "threa-agents"
  const reconnectIntervalMs = watchIntervalMs()
  const claudeConfig = readThreaChannelConfig()
  const piConfig = readPiRemoteConfig()
  const targetFor = (config: { baseUrl?: string; workspaceId?: string; apiKey?: string }) => {
    const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
    const apiKey = process.env.THREA_API_KEY || config.apiKey
    if (!workspaceId || !apiKey) return undefined
    return { baseUrl: configuredThreaBaseUrl(config), workspaceId, apiKey }
  }
  const targets = uniqueSupervisorTargets([targetFor(claudeConfig), targetFor(piConfig)])
  if (targets.length === 0) throw new Error("harnessd: no Threa credentials found for the supervisor socket")

  let reconcileChain = Promise.resolve()
  let unavailablePasses = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  // Returns the chain, not void: `startupReconciliation` runs the tombstone pass
  // after the sweep specifically so it does not hold the lock while boot revival
  // waits, and a fire-and-forget sweep would put them back in a race for it.
  const reconcile = (target?: BotSessionRestoredPayload): Promise<void> => {
    reconcileChain = reconcileChain
      .then(async () => {
        if (!options.dryRun) ensureTmuxSession(session, true)
        // Unarchive/boot revival restores pruned worktrees: unarchiving on Threa
        // is an explicit revive request. Manual `up` requires --recreate-worktree.
        const unavailable = await resumeActive(
          { ...options, tmux: session, recreateWorktree: true, respectProbeBackoff: true },
          target
        )
        // Reap on the untargeted sweep only: a restore event means a specific
        // scratchpad just came BACK, which is the opposite of reapable.
        if (!target && !options.dryRun) {
          await reapArchived({ observingSinceMs: watchStartedAtMs }).catch((error) =>
            console.warn(`harnessd: reap pass failed: ${error instanceof Error ? error.message : String(error)}`)
          )
        }
        if (!unavailable) {
          // A targeted restore event must not cancel an outstanding full
          // reconnect catch-up: another dormant runtime may still need it.
          if (!target) {
            unavailablePasses = 0
            if (retryTimer) clearTimeout(retryTimer)
            retryTimer = undefined
          }
          return
        }
        unavailablePasses += 1
        const delayMs = unavailableBackoffMs(reconnectIntervalMs, unavailablePasses)
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          reconcile()
        }, delayMs)
        console.warn(`harnessd: reconciliation unavailable; retrying in ${delayMs}ms`)
      })
      .catch((error) => {
        console.error(`harnessd: reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return reconcileChain
  }

  await startupReconciliation(defaultStartupReconciliationDeps(() => reconcile(), options.dryRun ?? false))

  const transports = targets.map(
    (target) =>
      new BotSupervisorTransport({
        ...target,
        onReady: () => reconcile(),
        onSessionRestored: (payload) => reconcile(payload),
        log: (message) => console.warn(`harnessd: supervisor socket: ${message}`),
      })
  )
  console.log(`harnessd: listening for unarchived sessions with ${transports.length} supervisor socket(s)`)
  await runWatchLoop({
    runPass: async () => {
      await Promise.all(transports.map((transport) => transport.connect()))
    },
    sleep: Bun.sleep,
    intervalMs: reconnectIntervalMs,
    onError: (error) => {
      console.error(`harnessd: supervisor connect failed: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}

/**
 * Clean up worktrees whose scratchpad was archived while nothing was running to
 * notice. The live-runtime wind-down cannot cover that case; harnessd outlives
 * reboots, so the backstop lives here.
 */
export async function reapArchived(options: { dryRun?: boolean; observingSinceMs?: number } = {}): Promise<void> {
  const target = threaTarget("the reap pass")

  // Same lock as resumeActive: a revive can be recreating the very worktree
  // this pass would force-remove, and they race the server independently.
  const deps = defaultReapDeps(target)
  if (options.observingSinceMs !== undefined) deps.observingSinceMs = options.observingSinceMs
  const release = options.dryRun ? () => {} : await acquireProcessLock(resumeActiveLockPath())
  let outcomes
  try {
    outcomes = await reapArchivedWorktrees(deps, options.dryRun ?? false)
  } finally {
    release()
  }
  if (outcomes.length === 0) {
    console.log("No recorded harness links.")
    return
  }
  const counts = new Map<string, number>()
  for (const outcome of outcomes) {
    console.log(`${outcome.status}\t${outcome.worktree}${outcome.detail ? `\t${outcome.detail}` : ""}`)
    counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1)
  }
  console.log(`harnessd: ${[...counts].map(([status, count]) => `${count} ${status}`).join(", ")}`)
}

export async function bootResume(options: ResumeOptions): Promise<void> {
  await watchUnarchived(options)
}

export function installBootResumeAgent(options: ResumeOptions): void {
  installBootResume(options.tmux ?? "threa-agents")
}

export async function resumeActive(options: ResumeOptions, target?: BotSessionRestoredPayload): Promise<boolean> {
  if (options.dryRun) return resumeActiveUnlocked(options, target)
  const release = await acquireProcessLock(resumeActiveLockPath())
  try {
    return await resumeActiveUnlocked(options, target)
  } finally {
    release()
  }
}

export type ReviveStatus =
  | "started"
  | "would start"
  | "already running"
  | "failed"
  | "skipped stopped"
  | "skipped missing link"
  | "skipped missing credentials"
  | "skipped missing session id"
  | "skipped missing cwd"
  | "skipped occupied"
  | "skipped identity mismatch"
  | "skipped archived"
  | "skipped inaccessible"
  | "skipped unavailable"

export interface ReviveOutcome {
  status: ReviveStatus
  detail?: string
}

export interface ReviveDeps {
  claudeConfig: ThreaChannelConfig
  piConfig: PiRemoteConfig
  paneStatus: (agent: ManagedAgent) => ManagedAgentPane["status"]
  /** Live Claude pids already in this worktree, corroborated against the process table. */
  claudeProcessesIn: (worktree: string) => number[]
  pathExists: (path: string) => boolean
  scratchpadStatus: (params: {
    baseUrl: string
    workspaceId: string
    apiKey: string
    streamId: string
  }) => Promise<ScratchpadStatus>
  preflight: (params: Parameters<typeof preflightRuntimeSession>[0]) => Promise<RuntimePreflightResult>
  restoreWorktree: (agent: ManagedAgent) => { restored: boolean; reason?: string }
  restorableWorktree: (agent: ManagedAgent) => { repo: string } | { reason: string }
  piLink: (runtimeSessionId: string) => PiRemoteSession | undefined
  /** The one identity resolver, injected so a revival decision is testable without the local stores. */
  claudeIdentity: (agent: ManagedAgent, config: ThreaChannelConfig) => ResolvedRuntimeIdentity
  resumeRuntime: (agent: ManagedAgent, options: ResumeOptions) => Promise<SpawnResult>
  persist: (agent: ManagedAgent) => void
  killWindow: (windowId: string) => void
}

export function defaultReviveDeps(): ReviveDeps {
  return {
    claudeConfig: readThreaChannelConfig(),
    piConfig: readPiRemoteConfig(),
    paneStatus: (agent) => resolveManagedAgentPane(agent).status,
    claudeProcessesIn: liveClaudePidsIn,
    pathExists: existsSync,
    scratchpadStatus: fetchScratchpadStatus,
    preflight: preflightRuntimeSession,
    restoreWorktree: restoreManagedWorktree,
    restorableWorktree: restorableWorktreeSource,
    piLink: readPiRemoteSession,
    claudeIdentity: claudeAgentIdentity,
    resumeRuntime: (agent, options) =>
      (agent.runtime === "pi" ? new PiRuntimeSpawner() : new ClaudeRuntimeSpawner()).resume(agent, options),
    persist: upsertAgent,
    killWindow: (windowId) => {
      output(["tmux", "kill-window", "-t", windowId], { allowFailure: true })
    },
  }
}

/** One agent's eligibility decision and (outside dry-run) revival. Undefined = not the targeted restore event's agent. */
export async function reviveAgent(
  storedAgent: ManagedAgent,
  options: ResumeOptions,
  deps: ReviveDeps,
  target?: BotSessionRestoredPayload
): Promise<ReviveOutcome | undefined> {
  let agent = storedAgent
  if (agent.runtime === "pi" && !agent.scratchpadUrl && agent.runtimeSessionId) {
    const link = deps.piLink(agent.runtimeSessionId)
    if (link) {
      agent = { ...agent, scratchpadUrl: link.scratchpadUrl, instanceId: link.instanceId, updatedAt: now() }
      if (!options.dryRun) deps.persist(agent)
      console.log(`repair-inventory\t${agent.name}\tPi remote link recovered`)
    }
  }
  const scratchpad = agent.scratchpadUrl ? parseScratchpadUrl(agent.scratchpadUrl) : undefined
  const paneStatus = deps.paneStatus(agent)
  // A targeted restore event decides one agent, so logging the whole inventory
  // would bury the line this exists to surface.
  if (!target || scratchpad?.streamId === target.rootStreamId) {
    const recorded = agent.runtimeSessionId ?? "-"
    const claude = agent.runtime === "claude" && Boolean(agent.worktree)
    const identity = claude ? deps.claudeIdentity(agent, deps.claudeConfig) : undefined
    // `drifted` is measured against the DERIVATION, not the resolution. Scoring
    // it against the resolved id makes it structurally unreachable — the
    // inventory rung returns the recorded id, so the two always agree — and
    // this is the line that surfaced the 2026-07-28 duplicate-session storm.
    const derived = claude ? deriveClaudeRuntimeIdentity(agent.worktree!, deps.claudeConfig).runtimeSessionId : "-"
    console.log(
      `resolve\t${agent.name}\t${identityVerdict(paneStatus, recorded, derived)}\t${recorded}\t${derived}\t${identity?.runtimeSessionId ?? "-"}\t${identity?.source ?? "-"}`
    )
  }
  // Ambiguity counts as alive: the next move is spawning a replacement, and a
  // duplicate agent is worse than a missed revival.
  if (paneStatus !== "missing") return { status: "already running" }
  if (agent.status === "stopped") return { status: "skipped stopped" }
  if (!agent.scratchpadUrl) return { status: "skipped missing link", detail: "no scratchpad URL recorded" }
  if (!scratchpad) return { status: "skipped missing link", detail: `invalid scratchpad URL: ${agent.scratchpadUrl}` }
  if (target && scratchpad.streamId !== target.rootStreamId) return undefined
  if (target) {
    let targetInstanceId = agent.instanceId
    let targetRuntimeSessionId = agent.runtimeSessionId
    if (agent.runtime === "pi" && targetRuntimeSessionId) {
      targetInstanceId ??= deps.piLink(targetRuntimeSessionId)?.instanceId
    } else if (agent.runtime === "claude" && !targetInstanceId && !targetRuntimeSessionId && agent.worktree) {
      const identity = deps.claudeIdentity(agent, deps.claudeConfig)
      targetInstanceId = identity.instanceId
      targetRuntimeSessionId = identity.runtimeSessionId
    }
    if (
      !restoredSessionMatches(
        { rootStreamId: scratchpad.streamId, instanceId: targetInstanceId, runtimeSessionId: targetRuntimeSessionId },
        target
      )
    ) {
      return { status: "skipped identity mismatch", detail: "restore event identity does not match inventory" }
    }
  }
  const runtimeConfig = agent.runtime === "pi" ? deps.piConfig : deps.claudeConfig
  const workspaceId = process.env.THREA_WORKSPACE_ID || runtimeConfig.workspaceId
  const apiKey = process.env.THREA_API_KEY || runtimeConfig.apiKey
  const baseUrl = configuredThreaBaseUrl(runtimeConfig)
  if (scratchpad.baseUrl !== baseUrl) {
    return {
      status: "skipped identity mismatch",
      detail: "scratchpad URL origin does not match configured Threa base URL",
    }
  }
  if (workspaceId && scratchpad.workspaceId && workspaceId !== scratchpad.workspaceId) {
    return { status: "skipped identity mismatch", detail: "scratchpad workspace does not match configured workspace" }
  }
  const targetWorkspaceId = scratchpad.workspaceId || workspaceId
  if (!targetWorkspaceId || !apiKey) return { status: "skipped missing credentials" }

  // A targeted restore event is the server saying this stream is live again, so it
  // always probes; only the untargeted sweep honours the backoff.
  if (options.respectProbeBackoff && !target && probeSuppressed(agent, Date.now())) {
    return { status: "skipped inaccessible", detail: `probe suppressed until ${agent.probeBackoffUntil}` }
  }
  const status = await deps.scratchpadStatus({
    baseUrl,
    workspaceId: targetWorkspaceId,
    apiKey,
    streamId: scratchpad.streamId,
  })
  if (status === "inaccessible") {
    const backedOff = withProbeBackoff(agent, { intervalMs: watchIntervalMs(), nowMs: Date.now() })
    if (!options.dryRun) deps.persist(backedOff)
    return { status: "skipped inaccessible", detail: `next probe after ${backedOff.probeBackoffUntil}` }
  }
  if (status !== "unavailable") {
    const cleared = withoutProbeBackoff(agent, Date.now())
    if (cleared) {
      if (!options.dryRun) deps.persist(cleared)
      agent = cleared
    }
  }
  if (status !== "active") return { status: `skipped ${status}` }
  if (agent.runtime === "pi" && !agent.runtimeSessionId) {
    return { status: "skipped missing session id", detail: "original Pi --session-id is not recorded" }
  }
  if (agent.runtime === "claude" && Boolean(agent.instanceId) !== Boolean(agent.runtimeSessionId)) {
    return { status: "skipped missing session id", detail: "incomplete Claude runtime identity" }
  }
  const piLink = agent.runtimeSessionId ? deps.piLink(agent.runtimeSessionId) : undefined
  if (agent.runtime === "pi" && !piLink) {
    return { status: "skipped missing session id", detail: "Pi remote link is missing or disabled" }
  }
  if (agent.runtime === "pi" && piLink?.rootStreamId !== scratchpad.streamId) {
    return {
      status: "skipped identity mismatch",
      detail: `Pi remote link root mismatch: expected ${scratchpad.streamId}, got ${piLink?.rootStreamId}`,
    }
  }
  if (agent.runtime === "pi" && agent.instanceId && agent.instanceId !== piLink?.instanceId) {
    return {
      status: "skipped identity mismatch",
      detail: `Pi remote instance mismatch: expected ${agent.instanceId}, got ${piLink?.instanceId}`,
    }
  }

  const worktreeMissing = !agent.worktree || !deps.pathExists(agent.worktree)
  if (worktreeMissing && !options.recreateWorktree) {
    return { status: "skipped missing cwd", detail: agent.worktree ?? "no worktree path recorded" }
  }
  if (worktreeMissing) {
    const source = deps.restorableWorktree(agent)
    if ("reason" in source) return { status: "skipped missing cwd", detail: source.reason }
  }
  // Second, tmux-independent liveness source, checked only here because it
  // costs a `ps` per registry entry and only a would-be launch needs it.
  // On 2026-07-28 the pane check alone let nine passes each start another
  // Claude in one worktree, all claiming the same runtime session; the process
  // table would have said "occupied" on the second pass regardless of whatever
  // the pane lookup was doing.
  if (agent.runtime === "claude" && agent.worktree) {
    const occupants = deps.claudeProcessesIn(agent.worktree)
    if (occupants.length > 0) {
      return {
        status: "skipped occupied",
        detail: `Claude already running in ${agent.worktree} (pid ${occupants.join(", ")})`,
      }
    }
  }
  // Dry-run exits before preflight: registering the bot-runtime session mutates server state.
  if (options.dryRun) {
    return {
      status: "would start",
      detail: `${agent.scratchpadUrl}${worktreeMissing ? " (recreates worktree)" : ""}`,
    }
  }
  if (worktreeMissing) {
    const worktree = deps.restoreWorktree(agent)
    if (worktree.reason) return { status: "skipped missing cwd", detail: worktree.reason }
    if (worktree.restored) console.log(`restore-worktree\t${agent.name}\t${agent.worktree}`)
  }
  if (!agent.worktree || !deps.pathExists(agent.worktree)) {
    return { status: "skipped missing cwd", detail: agent.worktree ?? "no worktree path recorded" }
  }

  let instanceId: string
  let runtimeSessionId: string
  if (agent.runtime === "pi") {
    instanceId = piLink!.instanceId
    runtimeSessionId = agent.runtimeSessionId!
  } else {
    const identity = deps.claudeIdentity(agent, deps.claudeConfig)
    instanceId = identity.instanceId
    runtimeSessionId = identity.runtimeSessionId
  }

  const configuredDisplayName =
    agent.runtime === "pi" ? deps.piConfig.defaultDisplayName : deps.claudeConfig.displayName
  const displayPrefix =
    process.env.THREA_DISPLAY_NAME || configuredDisplayName || (agent.runtime === "pi" ? "Pi" : "Claude Code")
  const displayName = `${displayPrefix} - ${basename(agent.worktree)}`.slice(0, 100)
  const preflight = await deps.preflight({
    baseUrl,
    workspaceId: targetWorkspaceId,
    apiKey,
    runtimeKind: agent.runtime === "pi" ? "pi-local" : "claude-code-channel",
    instanceId,
    runtimeSessionId,
    displayName,
    localCwd: agent.worktree,
    expectedRootStreamId: scratchpad.streamId,
    labelName: process.env.THREA_DEFAULT_LABEL || runtimeConfig.defaultLabel || "coding",
  })
  if (preflight.status === "mismatch") {
    return {
      status: "skipped identity mismatch",
      detail: `session link root mismatch: expected ${preflight.expectedRootStreamId}, got ${preflight.rootStreamId}`,
    }
  }
  if (preflight.status !== "linked") return { status: `skipped ${preflight.status}`, detail: preflight.reason }

  const resumableAgent = { ...agent, instanceId, runtimeSessionId }
  let result: SpawnResult
  try {
    result = await deps.resumeRuntime(resumableAgent, options)
  } catch (error) {
    deps.persist({ ...resumableAgent, status: "error", updatedAt: now(), lastOutput: String(error).slice(-4000) })
    return { status: "failed", detail: `launch failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Archive-during-launch TOCTOU: the preflight passed, but if the scratchpad
  // was archived/deleted before the runtime attached, the window would wedge
  // and read as "already running" forever — verify and kill instead of record.
  // "unavailable" keeps the window: can't verify, and the runtime reconnects.
  const recheck = await deps.scratchpadStatus({
    baseUrl,
    workspaceId: targetWorkspaceId,
    apiKey,
    streamId: scratchpad.streamId,
  })
  if (recheck === "archived" || recheck === "inaccessible") {
    if (result.tmuxWindowId) deps.killWindow(result.tmuxWindowId)
    deps.persist({
      ...resumableAgent,
      status: "error",
      updatedAt: now(),
      lastOutput: `scratchpad became ${recheck} during launch; window killed`,
    })
    return { status: `skipped ${recheck}`, detail: "scratchpad state changed during launch; window killed" }
  }
  try {
    deps.persist({
      ...resumableAgent,
      tmuxSession: result.tmuxSession,
      tmuxWindow: result.tmuxWindow,
      tmuxWindowId: result.tmuxWindowId,
      tmuxPaneId: result.tmuxPaneId,
      status: "online",
      updatedAt: now(),
      lastOutput: result.output.slice(-4000),
    })
  } catch (error) {
    // Inventory lost the new window identity, so a later pass would search the
    // old fields and double-start — kill the untracked window instead.
    if (result.tmuxWindowId) deps.killWindow(result.tmuxWindowId)
    return {
      status: "failed",
      detail: `inventory write failed after launch; window killed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const detail =
    agent.runtime === "claude" ? `bypass ${recordedNoYolo(agent) ? "disabled" : "enabled"}` : "Pi session reused"
  return { status: "started", detail }
}

async function resumeActiveUnlocked(options: ResumeOptions, target?: BotSessionRestoredPayload): Promise<boolean> {
  const deps = defaultReviveDeps()
  const rows = readInventory()
  // A targeted restore is the server saying this scratchpad came back, which is
  // exactly the evidence a tombstone lacks.
  const agents = latestAgentsByIdentity(rows, undefined, Boolean(target))
  const excluded = target ? 0 : rows.filter((agent) => agent.tombstonedAt).length
  if (excluded > 0) console.log(`harnessd: ${excluded} tombstoned row(s) not evaluated`)
  if (agents.length === 0) {
    console.log("No managed agents.")
    return false
  }
  const counts = new Map<ReviveStatus, number>()
  let unavailable = false
  let evaluated = 0
  for (const agent of agents) {
    evaluated += 1
    const outcome = await reviveAgent(agent, options, deps, target)
    if (!outcome) continue
    console.log(`${outcome.status}\t${agent.name}${outcome.detail ? `\t${outcome.detail}` : ""}`)
    counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1)
    if (outcome.status === "skipped unavailable") {
      unavailable = true
      break
    }
  }
  const parts = [...counts.entries()].map(([status, count]) => `${count} ${status}`)
  if (unavailable && evaluated < agents.length) {
    parts.push(`${agents.length - evaluated} not evaluated (sweep aborted while Threa unavailable)`)
  }
  if (parts.length > 0) console.log(`harnessd: ${parts.join(", ")}`)
  return unavailable
}

export function listAgents(): void {
  const agents = readInventory()
  if (agents.length === 0) {
    console.log("No managed agents.")
    return
  }
  for (const agent of agents) {
    const tmux = agent.tmuxSession && agent.tmuxWindow ? `${agent.tmuxSession}:${agent.tmuxWindow}` : "-"
    const marker = agent.tombstonedAt ? "\ttombstoned" : ""
    console.log(
      `${agent.id}\t${agent.status}\t${agent.runtime}\t${agent.name}\t${tmux}\t${agent.scratchpadUrl ?? "-"}${marker}`
    )
  }
}

export function stopAgent(ref: string): void {
  const agent = findAgent(ref)
  const target = resolveAgentTarget(agent).windowId
  const result = output(["tmux", "kill-window", "-t", target], { allowFailure: true })
  if (result.exitCode !== 0) die(result.stderr.trim() || `tmux kill-window failed for ${target}`)
  upsertAgent({ ...agent, status: "stopped", updatedAt: now() })
  console.log(`harnessd: stopped ${agent.name} (${target})`)
}

/**
 * The pane to act on, resolved by runtime identity rather than the recorded
 * tmux id — which a new tmux server hands to somebody else. Read-only: the
 * stored ids are a tie-breaker, never the answer, so there is nothing to
 * repair.
 */
function resolveAgentTarget(
  agent: ManagedAgent,
  panes?: LocalTmuxPane[],
  links: () => HarnessLink[] = readHarnessLinks
): LocalTmuxPane {
  const resolved = resolveManagedAgentPane(agent, panes, undefined, undefined, links)
  if (resolved.status === "ambiguous") die(`${agent.name}: ${resolved.reason}`)
  if (resolved.status === "missing") die(`${agent.name} has no live tmux pane`)
  // Killing or typing into the wrong window is the failure this resolver
  // exists to prevent, so an id we cannot corroborate is not good enough.
  if (resolved.status === "unverified") die(`${agent.name}: ${resolved.reason}; restart the managed session`)
  return resolved.pane
}

/** Nudge the linked agent's TUI with Enter (e.g. accept a blocking prompt). */
export function kickAgent(
  ref: string,
  send: typeof sendKeys = sendKeys,
  discover: (runtimeSessionId: string) => LocalTmuxPane | undefined = findLocalClaudeChannelPane,
  panes?: LocalTmuxPane[],
  links: () => HarnessLink[] = readHarnessLinks
): void {
  const managed = findAgentOrUndefined(ref, readInventoryReadonly())
  if (managed) {
    const target = resolveAgentTarget(managed, panes, links).paneId
    send(target, ["Enter"])
    console.log(`harnessd: kicked ${target}`)
    return
  }

  const pane = discover(ref)
  if (!pane) {
    die(`no managed agent found for ${ref}; no live local Claude channel pane matched that runtime session`)
  }
  send(pane.paneId, ["Enter"])
  console.log(
    `harnessd: kicked unmanaged Claude channel pane ${pane.paneId} (PID ${pane.panePid}, ${pane.sessionName}:${pane.windowName})`
  )
}

/** Send Esc to interrupt the agent's current turn (Claude Code / Pi) without killing the window. */
export function interruptAgent(ref: string): void {
  const target = resolveAgentTarget(findAgent(ref)).paneId
  sendKeys(target, ["Escape"])
  console.log(`harnessd: interrupted ${target}`)
}

/** Interrupt the current turn, then (if given) type a follow-up and submit it. */
export function steerAgent(ref: string, text: string): void {
  const target = resolveAgentTarget(findAgent(ref)).paneId
  sendKeys(target, ["Escape"])
  if (text) {
    // Esc restores the interrupted message into the input box; clear it (Ctrl-U)
    // before typing so the follow-up doesn't concatenate with that residue and
    // submit as a plain prompt.
    sendKeys(target, ["C-u"])
    sendKeys(target, ["-l", text])
    sendKeys(target, ["Enter"])
  }
  console.log(`harnessd: steered ${target}`)
}

/** Raw `tmux send-keys` passthrough to the agent's pane (tokens follow tmux rules). */
export function sendKeysToAgent(ref: string, keys: string[]): void {
  if (keys.length === 0) die("keys requires at least one key or token")
  const target = resolveAgentTarget(findAgent(ref)).paneId
  sendKeys(target, keys)
  console.log(`harnessd: sent keys to ${target}`)
}

export function attachAgent(ref: string): void {
  const agent = findAgent(ref)
  const pane = resolveAgentTarget(agent)
  const target = pane.windowId
  if (process.env.TMUX) {
    const result = Bun.spawnSync(["tmux", "switch-client", "-t", target], { stdout: "inherit", stderr: "pipe" })
    if (result.exitCode !== 0) die(result.stderr.toString().trim() || `tmux switch-client failed for ${target}`)
    return
  }

  const select = output(["tmux", "select-window", "-t", target], { allowFailure: true })
  if (select.exitCode !== 0) die(select.stderr.trim() || `tmux select-window failed for ${target}`)
  const attach = Bun.spawnSync(["tmux", "attach-session", "-t", pane.sessionName], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  })
  if (attach.exitCode !== 0)
    die(attach.stderr.toString().trim() || `tmux attach-session failed for ${pane.sessionName}`)
}

export function doctor(): void {
  const checks: Array<[string, boolean, string]> = [
    ["bun", commandExists("bun"), "required"],
    ["git", commandExists("git"), "required"],
    ["tmux", commandExists("tmux"), "required"],
    ["docker", commandExists("docker"), "needed for setup:worktree"],
    ["pi", Boolean(process.env.THREA_HARNESSD_PI_BIN || commandPath("pi")), "needed for Pi agents"],
    ["claude", Boolean(process.env.THREA_HARNESSD_CLAUDE_BIN || commandPath("claude")), "needed for Claude agents"],
    [
      "tmux attached session",
      Boolean(attachedTmuxSession()),
      attachedTmuxSession()
        ? `windows spawn into '${attachedTmuxSession()}'`
        : "no attached session; falls back to session '0'",
    ],
    [
      "tmux session 0 (fallback)",
      output(["tmux", "has-session", "-t", "0"], { allowFailure: true }).exitCode === 0,
      "used when nothing is attached",
    ],
  ]
  for (const [name, ok, note] of checks) {
    console.log(`${ok ? "ok" : "missing"}\t${name}\t${note}`)
  }
  // A pane scan that never ran must not report zero drift: "0 of nothing" is
  // indistinguishable from a clean fleet, which is the shape of miss this
  // command exists to catch (INV-11).
  let panes: LocalTmuxPane[] | undefined
  let paneError: string | undefined
  try {
    panes = listLocalTmuxPanes()
  } catch (error) {
    paneError = error instanceof Error ? error.message : String(error)
  }
  const drift = identityConsistency({ panes: panes ?? [], config: readThreaChannelConfig() })
  const driftChecks: Array<[string, number | undefined]> = [
    ["identity drift (inventory rows)", drift.inventoryRows],
    ["identity drift (link records)", drift.linkRecords],
    ["identity drift (live panes)", panes ? drift.livePanes : undefined],
  ]
  console.log(
    `${drift.identityless === 0 ? "ok" : "drift"}\tidentity (rows with no recorded identity)\t${drift.identityless} resolve only by deriving from the hostname`
  )
  for (const [name, count] of driftChecks) {
    if (count === undefined) {
      console.log(`unknown\t${name}\tcould not inspect local tmux panes: ${paneError}`)
      continue
    }
    console.log(
      `${count === 0 ? "ok" : "drift"}\t${name}\t${count} carry an identity today's derivation cannot reproduce`
    )
  }
  console.log(`inventory\t${inventoryPath()}`)
  console.log(`repo\t${defaultRepo()}`)
}

export async function inferAndRun(text: string): Promise<void> {
  const lower = text.toLowerCase()
  if (/\b(list|status|inventory)\b/.test(lower)) {
    listAgents()
    return
  }
  const stopMatch = lower.match(/\b(stop|kill|archive)\s+([a-z0-9_-]+)/)
  if (stopMatch?.[2]) {
    stopAgent(stopMatch[2])
    return
  }
  if (/\b(spawn|start|create|new)\b/.test(lower)) {
    const runtime = lower.includes("claude") ? "claude" : "pi"
    const topic = lower
      .replace(/\b(spawn|start|create|new|agent|worktree|scratchpad|pi|claude|for|a|an|the|please)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    const name = normalizeName(topic || `${runtime}-agent`)
    await spawnAgent({ runtime, name, branch: inferBranch(name, lower), repo: defaultRepo() })
    return
  }
  die(`could not infer command from: ${text}`)
}
