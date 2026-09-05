import { readHarnessLinks, type HarnessLink } from "@threa/harness-client"
import { threaTarget } from "./commands"
import { now } from "./cli"
import { resolveManagedAgentPane, type ManagedAgentPane } from "./discovery"
import { die } from "./errors"
import { findAgent, upsertAgent } from "./inventory"
import { acquireProcessLock, resumeActiveLockPath } from "./lock"
import { defaultReapDeps, windDownLinkedWorktree, type ReapDeps, type WindDownDeps, type WindDownWindow } from "./reap"
import { parseScratchpadUrl } from "./resume"
import { failureExcerpt, postThrea, type ThreaTarget } from "./threa-http"
import type { ManagedAgent } from "./types"

export interface DoneDeps extends WindDownDeps, Pick<ReapDeps, "panes"> {
  findAgent: (ref: string) => ManagedAgent
  resolvePane: (agent: ManagedAgent) => ManagedAgentPane
  links: () => HarnessLink[]
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
    resolvePane: (agent) => resolveManagedAgentPane(agent),
    links: readHarnessLinks,
    lock: () => acquireProcessLock(resumeActiveLockPath()),
    persist: upsertAgent,
    endSession: (identity) => endRuntimeSession(target, identity),
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

/**
 * Wind a thread session down on purpose: commit, push, remove the worktree,
 * and end the Threa link — without waiting for the scratchpad to be archived.
 * The opt-in counterpart to the archive-driven reaper, sharing its wind-down
 * sequence via {@link windDownLinkedWorktree}.
 */
export async function doneAgent(ref: string, deps: DoneDeps): Promise<void> {
  const found = deps.findAgent(ref)
  const { worktree, instanceId, runtimeSessionId } = found
  if (!worktree || !instanceId || !runtimeSessionId) die("done needs a linked managed session")
  const agent: LinkedAgent = { ...found, worktree, instanceId, runtimeSessionId }

  const release = await deps.lock()
  try {
    const resolved = deps.resolvePane(agent)
    if (resolved.status === "ambiguous") die(`${agent.name}: ${resolved.reason}`)
    if (resolved.status === "unverified") die(`${agent.name}: ${resolved.reason}; restart the managed session`)
    const window: WindDownWindow =
      resolved.status === "found" ? { kind: "kill", pane: resolved.pane } : { kind: "none" }

    const link = linkFor(agent, deps.links())
    const panes = deps.panes()
    const outcome = await windDownLinkedWorktree(link, window, panes, deps)
    if (outcome.refused !== undefined) {
      die(`${agent.name}: teardown failed, nothing removed: ${outcome.refused}`)
    }

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

    console.log(
      `done\t${agent.name}\t${outcome.removed ? "worktree removed" : `worktree left: ${outcome.reason ?? "unknown reason"}`}\tlink ${ended === "ended" ? "ended" : "already ended"}`
    )
  } finally {
    release()
  }
}
