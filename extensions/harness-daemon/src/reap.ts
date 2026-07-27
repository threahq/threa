import {
  ARCHIVE_RESTORE_GRACE_MS,
  WS_BACKSTOP_POLL_MS,
  clearHarnessLink,
  readHarnessLinks,
  type HarnessLink,
} from "@threa/bot-runtime-client"
import { existsSync } from "node:fs"
import { pushBranchAndScheduleRemoval } from "./archive-wind-down"
import { listLocalTmuxPanes, resolveManagedAgentPane, type LocalTmuxPane } from "./discovery"
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

export type ReapStatus =
  | "reaped"
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
  scratchpadStatus: (streamId: string) => Promise<ScratchpadStatus>
  archivedAt: (streamId: string) => Promise<string | undefined>
  pathExists: (path: string) => boolean
  windDown: (cwd: string, log: (message: string) => void) => { pushed: boolean; reason?: string }
  killWindow: (windowId: string) => void
  forgetLink: (runtimeSessionId: string) => void
  now: () => number
  log: (message: string) => void
}

export function defaultReapDeps(target: { baseUrl: string; workspaceId: string; apiKey: string }): ReapDeps {
  return {
    links: readHarnessLinks,
    panes: listLocalTmuxPanes,
    scratchpadStatus: (streamId) => fetchScratchpadStatus({ ...target, streamId }),
    archivedAt: (streamId) => fetchScratchpadArchivedAt({ ...target, streamId }),
    pathExists: existsSync,
    windDown: pushBranchAndScheduleRemoval,
    killWindow: (windowId) => {
      output(["tmux", "kill-window", "-t", windowId], { allowFailure: true })
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
 */
function decideWindow(link: HarnessLink, panes: LocalTmuxPane[]): WindowDecision {
  const occupants = panes.filter((pane) => pane.cwd === link.worktree)
  // Nobody is in the worktree: the offline case this reaper exists for.
  if (occupants.length === 0) return { kind: "none" }

  const resolved = resolveManagedAgentPane(
    {
      runtime: link.runtimeKind === "pi-local" ? "pi" : "claude",
      runtimeSessionId: link.runtimeSessionId,
      worktree: link.worktree,
    },
    panes
  )
  if (resolved.status === "found" && occupants.length === 1 && resolved.pane.paneId === occupants[0]!.paneId) {
    return { kind: "kill", pane: resolved.pane }
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

  const window = decideWindow(link, deps.panes())
  if (window.kind === "refuse") return { ...base, status: window.status, detail: window.reason }

  if (!deps.pathExists(link.worktree)) {
    // Already gone — the record is the only leftover.
    if (!dryRun) deps.forgetLink(link.runtimeSessionId)
    return { ...base, status: "skipped worktree missing" }
  }

  if (dryRun) return { ...base, status: "would reap", detail: why }

  const report = deps.windDown(link.worktree, (message) => deps.log(`${link.worktree}: ${message}`))
  // The window goes either way: the scratchpad is archived, so the session is
  // over even when the cleanup refused (detached HEAD, unpushable branch). A
  // refusal leaves the worktree on disk for a human — nothing is lost.
  if (window.kind === "kill") deps.killWindow(window.pane.windowId)
  deps.forgetLink(link.runtimeSessionId)
  return {
    ...base,
    status: "reaped",
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
