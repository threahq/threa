import {
  ARCHIVE_RESTORE_GRACE_MS,
  WS_BACKSTOP_POLL_MS,
  clearHarnessLink,
  readHarnessLinks,
  type HarnessLink,
} from "@threa/bot-runtime-client"
import { existsSync } from "node:fs"
import { pushBranchAndRemoveWorktree } from "./archive-wind-down"
import { liveClaudePidsIn } from "./claude-registry"
import { canonicalOrRaw, listLocalTmuxPanes, resolveManagedAgentPane, type LocalTmuxPane } from "./discovery"
import { processAlive } from "./lock"
import { output } from "./shell"
import { fetchScratchpadArchivedAt, fetchScratchpadStatus, type ScratchpadStatus } from "./resume"

/**
 * The reaper: clean up worktrees whose scratchpad was archived while nothing
 * was around to notice.
 *
 * Two routes reach the same cleanup, and both land here because harnessd is
 * where `resume-active.lock` is held — a revive can be recreating the very
 * worktree this pass would force-remove:
 *
 *   - A live runtime watched its restore grace expire, marked its link record
 *     `windDownRequestedAt`, and exited. The decision is already made and the
 *     grace already served, so this pass acts on the next sweep with no
 *     further margin.
 *   - Nobody was around to decide: the archive landed while the owning runtime
 *     was dead or absent (asleep, rebooted, killed). A cold start does not
 *     help either — Claude's replaces an archived scratchpad with a fresh one
 *     rather than winding down — so the worktree and its window survive
 *     indefinitely. Those wait out {@link REAP_AFTER_MS}.
 */

/**
 * How long after `archivedAt` the reaper may act on a record NO runtime marked.
 *
 * A live runtime can take a full socket-backstop poll to notice the archive,
 * and then holds its own grace window before winding down. Acting sooner would
 * steal an unarchive from a runtime that was about to reattach, so wait out
 * both and add the same margin again. A `windDownRequestedAt` record skips
 * this entirely: the runtime already served the grace this margin protects,
 * and making it wait again would turn ordinary cleanup from 5 into 25 minutes.
 */
export const REAP_AFTER_MS = WS_BACKSTOP_POLL_MS + ARCHIVE_RESTORE_GRACE_MS * 2

/** Long enough for a SIGHUP'd Claude to finish flushing; short enough not to stall the sweep. */
const KILL_GRACE_MS = 5_000
const KILL_POLL_MS = 100

export type ReapStatus =
  | "reaped"
  /** Branch preserved, directory still on disk: the removal failed and nothing will retry it. */
  | "reaped, worktree left"
  | "would reap"
  | "skipped active"
  | "skipped grace"
  | "skipped worktree missing"
  | "skipped ambiguous"
  | "skipped occupied"
  | "skipped observer too young"
  | "skipped inaccessible"
  | "skipped unavailable"

export interface ReapOutcome {
  runtimeSessionId: string
  worktree: string
  status: ReapStatus
  detail?: string
}

export interface ReapDeps {
  /** Undefined for an explicit CLI run; set by the daemon so a just-woken pass waits out {@link OBSERVER_WARMUP_MS}. */
  observingSinceMs?: number
  links: () => HarnessLink[]
  panes: () => LocalTmuxPane[]
  /** Live Claude pids in this worktree, corroborated against the process table. */
  claudeProcessesIn: (worktree: string) => number[]
  canonicalPath: (path: string) => string
  scratchpadStatus: (streamId: string) => Promise<ScratchpadStatus>
  archivedAt: (streamId: string) => Promise<string | undefined>
  pathExists: (path: string) => boolean
  windDown: (cwd: string, log: (message: string) => void) => { pushed: boolean; removed: boolean; reason?: string }
  killWindow: (windowId: string) => void
  /** Resolves once the killed pane's process is gone, or after a bounded wait. */
  awaitExit: (pid: number) => Promise<void>
  forgetLink: (runtimeSessionId: string) => void
  now: () => number
  log: (message: string) => void
}

export function defaultReapDeps(target: { baseUrl: string; workspaceId: string; apiKey: string }): ReapDeps {
  return {
    links: readHarnessLinks,
    panes: listLocalTmuxPanes,
    claudeProcessesIn: liveClaudePidsIn,
    canonicalPath: canonicalOrRaw,
    scratchpadStatus: (streamId) => fetchScratchpadStatus({ ...target, streamId }),
    archivedAt: (streamId) => fetchScratchpadArchivedAt({ ...target, streamId }),
    pathExists: existsSync,
    windDown: pushBranchAndRemoveWorktree,
    killWindow: (windowId) => {
      output(["tmux", "kill-window", "-t", windowId], { allowFailure: true })
    },
    awaitExit: async (pid) => {
      for (let waited = 0; waited < KILL_GRACE_MS && processAlive(pid); waited += KILL_POLL_MS) {
        await Bun.sleep(KILL_POLL_MS)
      }
    },
    forgetLink: clearHarnessLink,
    now: Date.now,
    log: (message) => console.log(`reap\t${message}`),
  }
}

type WindowDecision =
  | { kind: "none" }
  | { kind: "kill"; pane: LocalTmuxPane }
  | { kind: "refuse"; status: ReapStatus; reason: string }

/**
 * Which window, if any, this record may kill.
 *
 * Matching on cwd alone is not enough. Worktree paths are stable per feature
 * name and get reused, so a record left behind by a crashed runtime can name a
 * directory a different, live session now occupies — reaping on that record
 * would push and delete the live session's work under the label "scratchpad
 * archived". Identity comes from `resolveManagedAgentPane`, the resolver built
 * for exactly this failure; occupancy is then the veto.
 *
 * Panes alone cannot answer occupancy. A Claude detached from tmux, or whose
 * window was killed while it kept running, leaves no pane and is very much
 * alive — and the empty-pane branch below is precisely the one that authorises
 * a force-remove. So the process table is a second, independent veto, the same
 * one `up` grew after the pane check alone let it launch duplicates. It is not
 * gated on `runtimeKind`: what is being destroyed is a directory, and a live
 * Claude in it is fatal whichever runtime the record names.
 */
function decideWindow(link: HarnessLink, panes: LocalTmuxPane[], deps: ReapDeps): WindowDecision {
  // Link records store a raw `process.cwd()` while tmux reports a resolved
  // path; on macOS /tmp vs /private/tmp alone is enough to read an occupied
  // worktree as empty, which is the one misreading that ends in a removal.
  const worktree = deps.canonicalPath(link.worktree)
  const occupants = panes.filter((pane) => deps.canonicalPath(pane.cwd) === worktree)
  const livePids = deps.claudeProcessesIn(link.worktree)

  if (occupants.length === 0) {
    // Nobody is in the worktree: the offline case this reaper exists for —
    // unless a paneless Claude is still running there.
    if (livePids.length === 0) return { kind: "none" }
    return {
      kind: "refuse",
      status: "skipped occupied",
      reason: `Claude is still running in ${link.worktree} with no pane (pid ${livePids.join(", ")})`,
    }
  }

  const resolved = resolveManagedAgentPane(
    {
      runtime: link.runtimeKind === "pi-local" ? "pi" : "claude",
      runtimeSessionId: link.runtimeSessionId,
      worktree: link.worktree,
    },
    panes
  )
  if (resolved.status === "found" && occupants.length === 1 && resolved.pane.paneId === occupants[0]!.paneId) {
    // The pane's own Claude is `panePid` (the same equivalence `reconnect`
    // relies on). Any other live pid in the directory is a session killing this
    // window would not stop.
    const strangers = livePids.filter((pid) => pid !== resolved.pane.panePid)
    if (strangers.length === 0) return { kind: "kill", pane: resolved.pane }
    return {
      kind: "refuse",
      status: "skipped occupied",
      reason: `${link.worktree} also holds a Claude this record's pane does not account for (pid ${strangers.join(", ")})`,
    }
  }
  return {
    kind: "refuse",
    status: resolved.status === "ambiguous" ? "skipped ambiguous" : "skipped occupied",
    reason:
      resolved.status === "ambiguous"
        ? resolved.reason
        : `${link.worktree} is occupied by a session this record does not identify as its own`,
  }
}

/** One recorded link's decision, and (outside dry-run) its cleanup. */
export async function reapLink(link: HarnessLink, deps: ReapDeps, dryRun: boolean): Promise<ReapOutcome> {
  const base = { runtimeSessionId: link.runtimeSessionId, worktree: link.worktree }
  const status = await deps.scratchpadStatus(link.rootStreamId)
  if (status === "unavailable") return { ...base, status: "skipped unavailable" }
  if (status === "active") return { ...base, status: "skipped active" }
  if (status === "inaccessible") {
    // 403/404 is indistinguishable from a missing scope, so it is never
    // grounds to delete anything.
    return { ...base, status: "skipped inaccessible", detail: "cannot read the scratchpad; leaving it alone" }
  }

  // The owning runtime watched the grace expire and handed the worktree over
  // before exiting. Re-deriving a margin from archivedAt would only re-serve a
  // window that is already spent.
  let why = "the owning runtime served its grace and asked for the wind-down"
  if (!link.windDownRequestedAt) {
    const archivedAt = await deps.archivedAt(link.rootStreamId)
    const archivedMs = archivedAt ? Date.parse(archivedAt) : Number.NaN
    if (!Number.isFinite(archivedMs)) {
      return { ...base, status: "skipped unavailable", detail: "archived but no readable archivedAt" }
    }
    const age = deps.now() - archivedMs
    if (age < REAP_AFTER_MS) {
      return {
        ...base,
        status: "skipped grace",
        detail: `archived ${Math.round(age / 60_000)}m ago; the owning runtime gets until ${Math.round(REAP_AFTER_MS / 60_000)}m`,
      }
    }
    why = `archived ${Math.round(age / 60_000)}m ago`
  }

  const window = decideWindow(link, deps.panes(), deps)
  if (window.kind === "refuse") return { ...base, status: window.status, detail: window.reason }

  if (!deps.pathExists(link.worktree)) {
    // Already gone — the record is the only leftover.
    if (!dryRun) deps.forgetLink(link.runtimeSessionId)
    return { ...base, status: "skipped worktree missing" }
  }

  if (dryRun) return { ...base, status: "would reap", detail: why }

  // The window goes either way: the scratchpad is archived, so the session is
  // over even when the cleanup refuses below (detached HEAD, unpushable
  // branch). A refusal leaves the worktree on disk for a human — nothing is
  // lost. It goes FIRST because the wind-down now removes the directory
  // synchronously, and the pane's shell sits in it.
  //
  // `tmux kill-window` returns once it has delivered the signal, not once the
  // process is gone. Removing the directory in that gap deletes the cwd of a
  // Claude still flushing its transcript, so wait for the pane to actually
  // exit — the grace the old detached `sleep 5` provided by accident.
  if (window.kind === "kill") {
    deps.killWindow(window.pane.windowId)
    await deps.awaitExit(window.pane.panePid)
  }
  const report = deps.windDown(link.worktree, (message) => deps.log(`${link.worktree}: ${message}`))
  // Forgotten either way, matching the pre-existing contract for a refused
  // wind-down: the branch is the thing that had to survive, and a directory
  // left behind is for a human. What must not happen is reporting it gone.
  deps.forgetLink(link.runtimeSessionId)
  return {
    ...base,
    status: report.removed ? "reaped" : "reaped, worktree left",
    detail: `pushed=${report.pushed}${report.reason ? ` (${report.reason})` : ""}${window.kind === "kill" ? ` window=${window.pane.windowId}` : ""}`,
  }
}

/**
 * How long this process must have been watching before its automatic pass may
 * reap.
 *
 * `archivedAt` keeps accruing while the machine sleeps, so on wake the margin
 * can already be spent — but the runtime that owns the worktree was asleep
 * too, and its detection-plus-grace clock only restarts now. Reaping in that
 * instant races a live runtime that never got its chance. An explicitly
 * invoked `reap` skips this: a human asking is the signal, and so is a
 * `windDownRequestedAt` record — a runtime that already decided cannot be the
 * runtime this window is holding a place for.
 */
export const OBSERVER_WARMUP_MS = WS_BACKSTOP_POLL_MS + ARCHIVE_RESTORE_GRACE_MS

export async function reapArchivedWorktrees(deps: ReapDeps, dryRun = false): Promise<ReapOutcome[]> {
  const links = deps.links()
  if (links.length === 0) return []
  const warmingUp = deps.observingSinceMs !== undefined && deps.now() - deps.observingSinceMs < OBSERVER_WARMUP_MS
  const outcomes: ReapOutcome[] = []
  for (const link of links) {
    if (warmingUp && !link.windDownRequestedAt) {
      outcomes.push({
        runtimeSessionId: link.runtimeSessionId,
        worktree: link.worktree,
        status: "skipped observer too young",
        detail: "watching since less than one detection window; runtimes get first refusal",
      })
      continue
    }
    try {
      outcomes.push(await reapLink(link, deps, dryRun))
    } catch (error) {
      outcomes.push({
        runtimeSessionId: link.runtimeSessionId,
        worktree: link.worktree,
        status: "skipped unavailable",
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}
