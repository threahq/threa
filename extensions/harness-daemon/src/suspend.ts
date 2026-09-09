import { writeSessionWakeNote } from "@threahq/harness-client"
import { defaultClaudeDiskDeps, findLiveClaudeSessions, type ClaudeNativeSession } from "./claude-registry"
import { resolveManagedAgentPane, type ManagedAgentPane } from "./discovery"
import { claudeIdleVerdict, defaultIdleProbeDeps, suspendHeld, type IdleProbeDeps } from "./idle"
import { upsertAgent } from "./inventory"
import { output, shellQuote } from "./shell"
import { respawnPane } from "./tmux"
import type { ManagedAgent } from "./types"

/**
 * What sits in the pane while the session is wound down. A killed pane would
 * take the window with it and lose the operator's place in the session list,
 * and an empty one says nothing about why the agent is gone.
 */
export function suspendPlaceholderCommand(agent: ManagedAgent): string {
  const notice = `harnessd: ${agent.name} is suspended (idle). The next message on its scratchpad resumes it.`
  return `printf '%s\\n' ${shellQuote(notice)}; exec sleep 2147483647`
}

export type SuspendStatus = "suspended" | "would suspend" | "skipped"

export interface SuspendOutcome {
  status: SuspendStatus
  detail: string
}

export interface SuspendDeps {
  pane: (agent: ManagedAgent) => ManagedAgentPane
  /** Live Claude processes in a worktree, from the runtime's own registry. */
  sessions: (worktree: string) => ClaudeNativeSession[]
  probe: IdleProbeDeps
  respawn: (paneId: string, cwd: string, command: string) => void
  killWindow: (windowId: string) => void
  persist: (agent: ManagedAgent) => void
  writeWakeNote: (note: { runtimeSessionId: string; suspendedAt: string; wokeAt: string }) => void
  now: () => number
}

export function defaultSuspendDeps(): SuspendDeps {
  const disk = defaultClaudeDiskDeps()
  return {
    pane: (agent) => resolveManagedAgentPane(agent),
    sessions: (worktree) => findLiveClaudeSessions(worktree, disk),
    probe: defaultIdleProbeDeps(),
    respawn: respawnPane,
    killWindow: (windowId) => {
      output(["tmux", "kill-window", "-t", windowId], { allowFailure: true })
    },
    persist: upsertAgent,
    writeWakeNote: writeSessionWakeNote,
    now: Date.now,
  }
}

/**
 * Wind one idle Claude session down, keeping its row and its window.
 *
 * The order is what makes this safe against the revive sweep and against a
 * turn arriving mid-suspend: the row is marked `suspended` BEFORE anything is
 * killed, so a concurrent revive skips it instead of racing the respawn, and
 * the idle check is repeated after the mark so a session that picked work up
 * in between is rolled back online untouched. A turn that lands in the
 * sub-second between the second check and the kill still loses its wake — it
 * is claimed on the next message, which is why the mark, not the kill, is the
 * commit point.
 */
export function suspendAgent(
  agent: ManagedAgent,
  deps: SuspendDeps,
  options: { thresholdMs: number; dryRun?: boolean }
): SuspendOutcome {
  if (agent.runtime !== "claude") return { status: "skipped", detail: `${agent.runtime} sessions are not suspendable` }
  if (agent.status === "suspended") return { status: "skipped", detail: "already suspended" }
  if (agent.status === "stopped") return { status: "skipped", detail: "stopped" }
  if (!agent.worktree) return { status: "skipped", detail: "no worktree recorded" }
  if (suspendHeld(agent, deps.now())) return { status: "skipped", detail: `held until ${agent.suspendHoldUntil}` }

  const pane = deps.pane(agent)
  if (pane.status !== "found") {
    return { status: "skipped", detail: pane.status === "ambiguous" ? pane.reason : "no pane of its own" }
  }
  const verdict = readIdle(agent.worktree, deps, options.thresholdMs)
  if (!verdict.idle) return { status: "skipped", detail: verdict.reason }
  if (options.dryRun) return { status: "would suspend", detail: `idle ${Math.round(verdict.idleForMs / 60_000)}m` }

  const suspendedAt = new Date(deps.now()).toISOString()
  deps.persist({ ...agent, status: "suspended", suspendedAt, updatedAt: suspendedAt })
  const recheck = readIdle(agent.worktree, deps, options.thresholdMs)
  if (!recheck.idle) {
    const rolledBackAt = new Date(deps.now()).toISOString()
    deps.persist({ ...agent, status: "online", suspendedAt: undefined, updatedAt: rolledBackAt })
    return { status: "skipped", detail: `took work up while winding down: ${recheck.reason}` }
  }
  deps.respawn(pane.pane.paneId, agent.worktree, suspendPlaceholderCommand(agent))
  return { status: "suspended", detail: `idle ${Math.round(verdict.idleForMs / 60_000)}m` }
}

/**
 * One live Claude per worktree is the only case a wind-down can reason about:
 * with two, the registry cannot say which one the pane runs, and suspending
 * on the wrong one's idleness kills a working session.
 */
function readIdle(
  worktree: string,
  deps: SuspendDeps,
  thresholdMs: number
): { idle: true; idleForMs: number } | { idle: false; reason: string } {
  const sessions = deps.sessions(worktree)
  if (sessions.length === 0) return { idle: false, reason: "no live Claude session in the worktree" }
  if (sessions.length > 1) return { idle: false, reason: `${sessions.length} live Claude sessions in the worktree` }
  return claudeIdleVerdict(sessions[0]!, deps.probe, thresholdMs)
}

/**
 * Undo the suspension so the row is an ordinary revival candidate again, and
 * leave the note the resumed session briefs itself from.
 *
 * Nothing here starts a runtime: the caller hands the cleared row to the same
 * revive path a vanished pane takes, so a wake and a crash recovery converge
 * on one implementation.
 */
export function wakeAgent(agent: ManagedAgent, deps: SuspendDeps): ManagedAgent {
  const wokeAt = new Date(deps.now()).toISOString()
  if (agent.runtimeSessionId && agent.suspendedAt) {
    deps.writeWakeNote({ runtimeSessionId: agent.runtimeSessionId, suspendedAt: agent.suspendedAt, wokeAt })
  }
  const woken: ManagedAgent = { ...agent, status: "online", suspendedAt: undefined, updatedAt: wokeAt }
  deps.persist(woken)
  if (agent.tmuxWindowId) deps.killWindow(agent.tmuxWindowId)
  return woken
}
