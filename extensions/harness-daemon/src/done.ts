import { readHarnessLinks, type HarnessLink } from "@threa/harness-client"
import { threaTarget } from "./commands"
import { now } from "./cli"
import { die } from "./errors"
import { findAgent, upsertAgent } from "./inventory"
import { acquireProcessLock, resumeActiveLockPath } from "./lock"
import { postScratchpadNotice } from "./oom"
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
import { notifyStream, type StreamNoticeDeps } from "./spawn-attached"
import { failureExcerpt, postThrea, type ThreaTarget } from "./threa-http"
import type { ManagedAgent } from "./types"

export interface DoneDeps
  extends WindDownDeps, WindowDecisionDeps, StreamNoticeDeps, Pick<ReapDeps, "panes" | "pathExists"> {
  findAgent: (ref: string) => ManagedAgent
  /** Same lock as `clear`, so the watcher cannot revive mid-wind-down. */
  lock: () => Promise<() => void>
  persist: (agent: ManagedAgent) => void
  endSession: (identity: { instanceId: string; runtimeSessionId: string }) => Promise<"ended" | "not-found">
}

async function endRuntimeSession(
  target: ThreaTarget,
  identity: { instanceId: string; runtimeSessionId: string }
): Promise<"ended" | "not-found"> {
  const response = await postThrea(target, "/bot-runtime/sessions/end", identity)
  if (response.status === 404) return "not-found"
  if (!response.ok) throw new Error(`harnessd: could not end runtime session: ${await failureExcerpt(response)}`)
  return "ended"
}

export function defaultDoneDeps(): DoneDeps {
  const target = threaTarget("done")
  const base = defaultReapDeps(target)
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
    endSession: (identity) => endRuntimeSession(target, identity),
    postNotice: (streamId, content) =>
      postScratchpadNotice({ ...threaTarget("report a done outcome"), streamId, content }),
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
    return "worktree already gone"
  }

  const outcome = await windDownLinkedWorktree(link, window, panes, deps)
  if (outcome.refused !== undefined) die(`${agent.name}: teardown failed, nothing removed: ${outcome.refused}`)
  return outcome.removed ? "worktree removed" : `worktree left: ${outcome.reason ?? "unknown reason"}`
}

export interface DoneRequest {
  ref: string
  /** The scratchpad `/done` was typed in; the wind-down refuses any other root. */
  rootStreamId: string
}

/**
 * Wind a thread session down on purpose: commit, push, remove the worktree,
 * and end the Threa link — without waiting for the scratchpad to be archived.
 * The opt-in counterpart to the archive-driven reaper, sharing its vetoes via
 * {@link decideWindow} and its wind-down sequence via {@link windDownLinkedWorktree}.
 *
 * `/done` is typed in Threa and the pane it kills is the one that would have
 * reported back, so both the outcome and any failure are posted to the
 * scratchpad root — otherwise the user's session simply stops answering. The
 * root comes from the caller rather than the link, so a failure before the link
 * is resolved still has somewhere to report.
 */
export async function doneAgent(request: DoneRequest, deps: DoneDeps): Promise<void> {
  let label = request.ref
  try {
    const found = deps.findAgent(request.ref)
    const { worktree, instanceId, runtimeSessionId } = found
    if (!worktree || !instanceId || !runtimeSessionId) die("done needs a linked managed session")
    const agent: LinkedAgent = { ...found, worktree, instanceId, runtimeSessionId }
    label = agent.name

    const release = await deps.lock()
    try {
      const link = linkFor(agent, deps.links())
      // Waiting for the lock can take minutes, and a session relinked to another
      // scratchpad in that window belongs to whoever is sitting in it now.
      if (link.rootStreamId !== request.rootStreamId) {
        die(`${agent.name}: linked to ${link.rootStreamId}, not ${request.rootStreamId}`)
      }
      const worktreeOutcome = await windDownForDone(agent, link, deps)

      let ended: "ended" | "not-found"
      try {
        ended = await deps.endSession({ instanceId, runtimeSessionId })
      } finally {
        // Persisted whichever way endSession lands: the pane is already gone by
        // this point, so a throw from an unexpected status must still leave the
        // row reflecting the session that just ended, not the one before it.
        deps.persist({ ...agent, status: "stopped", updatedAt: now() })
      }
      if (ended === "not-found") deps.log(`${agent.name}: link already ended`)
      const linkOutcome = `link ${ended === "ended" ? "ended" : "already ended"}`

      await notifyStream(
        request.rootStreamId,
        `harnessd: \`${agent.name}\` is done — ${worktreeOutcome}, ${linkOutcome}.`,
        deps
      )
      console.log(`done\t${agent.name}\t${worktreeOutcome}\t${linkOutcome}`)
    } finally {
      release()
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await notifyStream(request.rootStreamId, `harnessd: \`/done\` for \`${label}\` failed: ${reason}`, deps)
    throw error
  }
}
