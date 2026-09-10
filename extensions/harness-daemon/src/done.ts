import { readCommandClaim, readHarnessLinks, type CommandClaim, type HarnessLink } from "@threahq/harness-client"
import { threaTarget } from "./commands"
import { now } from "./cli"
import { claimCommandReporter, consoleCommandReporter, type CommandReporter } from "./command-reporter"
import { die } from "./errors"
import { findAgent, upsertAgent } from "./inventory"
import { acquireProcessLock, resumeActiveLockPath } from "./lock"
import {
  decideWindow,
  defaultReapDeps,
  retireIdentities,
  windDownLinkedWorktree,
  type ReapDeps,
  type WindDownDeps,
  type WindowDecisionDeps,
} from "./reap"
import { parseScratchpadUrl } from "./resume"
import { runtimeThreaTarget, type RuntimeTargetResolver } from "./spawners"
import { failureExcerpt, postThrea, type ThreaTarget } from "./threa-http"
import type { ManagedAgent, RuntimeKind } from "./types"

export interface DoneDeps extends WindDownDeps, WindowDecisionDeps, Pick<ReapDeps, "panes" | "pathExists"> {
  findAgent: (ref: string) => ManagedAgent
  /** Same lock as `clear`, so the watcher cannot revive mid-wind-down. */
  lock: () => Promise<() => void>
  persist: (agent: ManagedAgent) => void
  endSession: (identity: {
    runtime: RuntimeKind
    instanceId: string
    runtimeSessionId: string
    /** The `/done` command itself, which ending the session must not cancel: it reports the outcome. */
    exceptInvocationId?: string
  }) => Promise<void>
  readClaim: (path: string) => CommandClaim
  commandReporter: (claim: CommandClaim) => CommandReporter
}

async function endRuntimeSession(
  target: ThreaTarget,
  identity: { instanceId: string; runtimeSessionId: string; exceptInvocationId?: string }
): Promise<void> {
  const response = await postThrea(target, "/bot-runtime/sessions/end", identity)
  if (!response.ok) {
    throw new Error(
      `harnessd: remote cleanup unresolved: could not end runtime session: ${await failureExcerpt(response)}`
    )
  }
}

export function defaultDoneDeps(
  targetForRuntime: RuntimeTargetResolver = runtimeThreaTarget,
  supervisorTarget: ThreaTarget = threaTarget("done")
): DoneDeps {
  const base = defaultReapDeps(supervisorTarget)
  return {
    panes: base.panes,
    pathExists: base.pathExists,
    claudeProcessesIn: base.claudeProcessesIn,
    profileFor: base.profileFor,
    teardown: base.teardown,
    killWindow: base.killWindow,
    awaitExit: base.awaitExit,
    windDown: base.windDown,
    forgetLink: base.forgetLink,
    forgetIdentities: base.forgetIdentities,
    canonicalPath: base.canonicalPath,
    identities: base.identities,
    log: base.log,
    findAgent,
    links: readHarnessLinks,
    lock: () => acquireProcessLock(resumeActiveLockPath()),
    persist: upsertAgent,
    endSession: ({ runtime, ...identity }) =>
      endRuntimeSession(targetForRuntime(runtime, "end a runtime session"), identity),
    readClaim: readCommandClaim,
    commandReporter: (claim) => claimCommandReporter(targetForRuntime(claim.runtime, "drive /done"), claim, "done"),
  }
}

type LinkedAgent = ManagedAgent & { worktree: string; instanceId: string; runtimeSessionId: string }

/** The real harness-link record for this session, or one rebuilt from the inventory row when none was found (e.g. after a crash cleared it). */
function linkFor(agent: LinkedAgent, links: HarnessLink[]): HarnessLink {
  const existing = links.find((link) => link.runtimeSessionId === agent.runtimeSessionId)
  if (existing) return existing
  const scratchpad = agent.scratchpadUrl ? parseScratchpadUrl(agent.scratchpadUrl) : undefined
  if (!scratchpad) die(`${agent.name}: no harness link record and no parseable scratchpadUrl to rebuild one`)
  return {
    runtimeKind: agent.runtime === "pi" ? "pi-local" : "claude-code-channel",
    runtimeSessionId: agent.runtimeSessionId,
    instanceId: agent.instanceId,
    rootStreamId: scratchpad.streamId,
    worktree: agent.worktree,
    pid: 0,
    updatedAt: now(),
  }
}

/** Kill the window, wind the worktree down, and clear the records — or say why nothing was destroyed. */
async function windDownForDone(agent: LinkedAgent, link: HarnessLink, deps: DoneDeps): Promise<string> {
  const panes = deps.panes()
  // The reaper's vetoes, unchanged: the directory is what gets force-removed, so
  // a paneless live Claude, a contested record, or a pane this record cannot
  // identify as its own refuses the wind-down here exactly as it would there.
  const window = decideWindow(link, panes, deps)
  if (window.kind === "refuse" || window.kind === "drain") die(`${agent.name}: ${window.reason}`)

  if (!deps.pathExists(link.worktree)) {
    // Removed by hand. Without this the wind-down would refuse forever on a
    // directory that is already gone, and the thread could never be finished.
    if (window.kind === "kill") {
      deps.killWindow(window.pane.windowId)
      await deps.awaitExit(window.pane.panePid)
    }
    deps.forgetLink(link.runtimeSessionId)
    retireIdentities(link.worktree, deps)
    return "Worktree already gone"
  }

  const outcome = await windDownLinkedWorktree(link, window, panes, deps)
  if (outcome.refused !== undefined) die(`${agent.name}: teardown failed, nothing removed: ${outcome.refused}`)
  return outcome.removed ? "Worktree removed" : `Worktree left: ${outcome.reason ?? "unknown reason"}`
}

export interface DoneRequest {
  ref: string
  /** The scratchpad `/done` was typed in; the wind-down refuses any other root. */
  rootStreamId: string
  /** The `/done` command's own claim, when Threa typed it; absent for a `done` typed at the terminal. */
  claimFile?: string
}

/**
 * Wind a thread session down on purpose: commit, push, remove the worktree,
 * and end the Threa link — without waiting for the scratchpad to be archived.
 * The opt-in counterpart to the archive-driven reaper, sharing its vetoes via
 * {@link decideWindow} and its wind-down sequence via {@link windDownLinkedWorktree}.
 *
 * The pane it kills is the one that claimed `/done`, so that command is handed
 * to this process instead: it is renewed across the lock wait, each stage is
 * reported into it, and it closes completed or failed — no message is posted.
 */
export async function doneAgent(request: DoneRequest, deps: DoneDeps): Promise<void> {
  const claim = request.claimFile ? deps.readClaim(request.claimFile) : undefined
  const reporter = claim ? deps.commandReporter(claim) : consoleCommandReporter("done")
  try {
    const found = deps.findAgent(request.ref)
    const { worktree, instanceId, runtimeSessionId } = found
    if (!worktree || !instanceId || !runtimeSessionId) die("done needs a linked managed session")
    const agent: LinkedAgent = { ...found, worktree, instanceId, runtimeSessionId }

    const release = await deps.lock()
    try {
      const link = linkFor(agent, deps.links())
      // Waiting for the lock can take minutes, and a session relinked to another
      // scratchpad in that window belongs to whoever is sitting in it now.
      if (link.rootStreamId !== request.rootStreamId) {
        die(`${agent.name}: linked to ${link.rootStreamId}, not ${request.rootStreamId}`)
      }
      await reporter.progress("Committing, pushing and removing the worktree")
      const worktreeOutcome = await windDownForDone(agent, link, deps)
      if (worktreeOutcome !== "Worktree removed") await reporter.progress(worktreeOutcome)

      await reporter.progress("Ending the session link")
      try {
        await deps.endSession({
          runtime: agent.runtime,
          instanceId,
          runtimeSessionId,
          ...(claim ? { exceptInvocationId: claim.invocationId } : {}),
        })
      } finally {
        // Persisted whichever way endSession lands: the pane is already gone by
        // this point, so a throw from an unexpected status must still leave the
        // row reflecting the session that just ended, not the one before it.
        deps.persist({ ...agent, status: "stopped", updatedAt: now() })
      }
      await reporter.complete()
      console.log(`done\t${agent.name}\t${worktreeOutcome}\tlink ended`)
    } finally {
      release()
    }
  } catch (error) {
    await reporter.fail(error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    reporter.stop()
  }
}
