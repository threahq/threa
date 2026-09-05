import { ARCHIVE_RESTORE_GRACE_MS, WS_BACKSTOP_POLL_MS } from "@threahq/bot-runtime-client"
import { clearHarnessLink, readHarnessLinks, type HarnessLink } from "@threa/harness-client"
import { existsSync } from "node:fs"
import { pushBranchAndRemoveWorktree } from "./archive-wind-down"
import { liveClaudePidsIn } from "./claude-registry"
import {
  forgetMintedIdentitiesFor,
  identityRecordsFor,
  matchesRuntimeKind,
  profileForWorktree,
  readMintedIdentities,
  type MintedIdentity,
} from "./identity-store"
import { windDownPolicyFor, type Profile, type WindDownPolicy } from "./profiles"
import { runTeardownCommands } from "./worktree"
import {
  attestedRuntimes,
  canonicalOrRaw,
  conflictingAttestations,
  listLocalTmuxPanes,
  parseClaudeChannelLaunch,
  parsePiLaunch,
  resolveManagedAgentPane,
  type LocalTmuxPane,
} from "./discovery"
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
  /** Record forgotten, directory untouched: two records name it and one may still be live. */
  | "drained contested record"
  | "skipped occupied"
  | "skipped observer too young"
  | "skipped inaccessible"
  | "skipped unavailable"
  /** The profile's teardown commands failed or timed out; nothing destructive ran. */
  | "skipped teardown failed"

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
  identities: () => MintedIdentity[]
  panes: () => LocalTmuxPane[]
  /** Live Claude pids in this worktree, corroborated against the process table. */
  claudeProcessesIn: (worktree: string) => number[]
  canonicalPath: (path: string) => string
  scratchpadStatus: (streamId: string) => Promise<ScratchpadStatus>
  archivedAt: (streamId: string) => Promise<string | undefined>
  pathExists: (path: string) => boolean
  windDown: (
    cwd: string,
    log: (message: string) => void,
    policy: WindDownPolicy
  ) => { pushed: boolean; removed: boolean; reason?: string }
  /** The profile this worktree was provisioned under for one runtime kind; no mint record ⇒ the built-in default profile. */
  profileFor: (worktree: string, runtimeKind: string) => Profile
  /** The profile's teardown commands, bounded. Runs before anything destructive. */
  teardown: (cwd: string, commands: string[]) => { ok: boolean; reason?: string }
  killWindow: (windowId: string) => void
  /** Resolves once the killed pane's process is gone, or after a bounded wait. */
  awaitExit: (pid: number) => Promise<void>
  forgetLink: (runtimeSessionId: string) => void
  /** Retires identity records for a worktree that is gone, and names what it retired. */
  forgetIdentities: (worktree: string) => string[]
  now: () => number
  log: (message: string) => void
}

export function defaultReapDeps(target: { baseUrl: string; workspaceId: string; apiKey: string }): ReapDeps {
  return {
    links: readHarnessLinks,
    identities: readMintedIdentities,
    panes: listLocalTmuxPanes,
    claudeProcessesIn: liveClaudePidsIn,
    canonicalPath: canonicalOrRaw,
    scratchpadStatus: (streamId) => fetchScratchpadStatus({ ...target, streamId }),
    archivedAt: (streamId) => fetchScratchpadArchivedAt({ ...target, streamId }),
    pathExists: existsSync,
    windDown: pushBranchAndRemoveWorktree,
    profileFor: (worktree, runtimeKind) => profileForWorktree(worktree, runtimeKind),
    teardown: runTeardownCommands,
    killWindow: (windowId) => {
      output(["tmux", "kill-window", "-t", windowId], { allowFailure: true })
    },
    awaitExit: async (pid) => {
      for (let waited = 0; waited < KILL_GRACE_MS && processAlive(pid); waited += KILL_POLL_MS) {
        await Bun.sleep(KILL_POLL_MS)
      }
    },
    forgetLink: clearHarnessLink,
    forgetIdentities: forgetMintedIdentitiesFor,
    now: Date.now,
    log: (message) => console.log(`reap\t${message}`),
  }
}

function conflictReason(link: HarnessLink, conflict: string[]): string {
  return `identity evidence for ${link.worktree} disagrees: ${conflict.join(", ")}`
}

/** `unknown` predates kinds and every such record was a Claude session — the convention every store reader applies. */
function linkRuntimeKind(link: HarnessLink): string {
  return link.runtimeKind === "pi-local" ? "pi-local" : "claude-code-channel"
}

function belongsToOtherKind(pane: LocalTmuxPane, kind: string): boolean {
  return kind === "pi-local"
    ? Boolean(parseClaudeChannelLaunch(pane.startCommand))
    : Boolean(parsePiLaunch(pane.startCommand))
}

/**
 * Who else claims this directory: another kind's identity records, or another
 * kind's live panes. Identity is per (directory, kind), so coexistence is
 * legitimate — but the wind-down mutates the DIRECTORY (commit, push, remove),
 * and doing that under a coexisting session destroys work this record never
 * owned. A shared directory is wound down under `preserve: "none"`.
 */
function sharedDirectoryClaimants(
  link: HarnessLink,
  panes: LocalTmuxPane[],
  deps: Pick<ReapDeps, "canonicalPath" | "identities">
): string[] {
  const kind = linkRuntimeKind(link)
  const worktree = deps.canonicalPath(link.worktree)
  const records = identityRecordsFor(link.worktree, deps.identities(), deps.canonicalPath).filter(
    (record) => !matchesRuntimeKind(record.runtimeKind, kind)
  )
  const foreignPanes = panes.filter(
    (pane) => deps.canonicalPath(pane.cwd) === worktree && belongsToOtherKind(pane, kind)
  )
  return [
    ...records.map((record) => `${record.runtimeSessionId} (${record.runtimeKind})`),
    ...foreignPanes.map((pane) => `pane ${pane.paneId}`),
  ]
}

export type WindowDecision =
  | { kind: "none" }
  /** Forget the record, destroy nothing: the directory's ownership is in doubt. */
  | { kind: "drain"; reason: string }
  | { kind: "kill"; pane: LocalTmuxPane }
  | { kind: "refuse"; status: ReapStatus; reason: string }

/** What {@link windDownLinkedWorktree} needs decided about the pane before it may destroy anything. */
export type WindDownWindow = { kind: "none" } | { kind: "kill"; pane: LocalTmuxPane }

/** The slice of {@link ReapDeps} {@link decideWindow} reads, so `done` can apply the same vetoes without faking a reap. */
export type WindowDecisionDeps = Pick<ReapDeps, "links" | "identities" | "claudeProcessesIn" | "canonicalPath">

/** The slice of {@link ReapDeps} {@link windDownLinkedWorktree} needs — narrow so a caller like `done` need not fake the archive-detection fields it never reaches. */
export type WindDownDeps = Pick<
  ReapDeps,
  | "profileFor"
  | "teardown"
  | "killWindow"
  | "awaitExit"
  | "windDown"
  | "forgetLink"
  | "forgetIdentities"
  | "canonicalPath"
  | "identities"
  | "log"
>

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
export function decideWindow(link: HarnessLink, panes: LocalTmuxPane[], deps: WindowDecisionDeps): WindowDecision {
  // Link records store a raw `process.cwd()` while tmux reports a resolved
  // path; on macOS /tmp vs /private/tmp alone is enough to read an occupied
  // worktree as empty, which is the one misreading that ends in a removal.
  const worktree = deps.canonicalPath(link.worktree)
  const kind = linkRuntimeKind(link)
  const inWorktree = panes.filter((pane) => deps.canonicalPath(pane.cwd) === worktree)
  // A pane that provably belongs to the OTHER runtime kind is a coexisting
  // session's, never this record's business: it neither counts as this
  // record's occupant nor may be killed. `sharedDirectoryClaimants` keeps the
  // directory itself safe for it.
  const occupants = inWorktree.filter((pane) => !belongsToOtherKind(pane, kind))
  const livePids = deps.claudeProcessesIn(link.worktree)
  // The pid a coexisting Claude pane owns is accounted for the same way the
  // kill branch accounts a record's own pane pid. A claude-kind record gets no
  // exemption: every claude pid in the directory is its namespace's to explain.
  const foreignClaudePanePids = new Set(
    kind === "pi-local"
      ? inWorktree.filter((pane) => parseClaudeChannelLaunch(pane.startCommand)).map((pane) => pane.panePid)
      : []
  )
  const unaccountedPids = livePids.filter((pid) => !foreignClaudePanePids.has(pid))

  const conflict = conflictingAttestations(
    link.worktree,
    attestedRuntimes(deps.links(), deps.canonicalPath),
    deps.identities(),
    deps.canonicalPath,
    kind
  )

  if (occupants.length === 0) {
    // Nobody is in the worktree: the offline case this reaper exists for —
    // unless a paneless Claude is still running there. A paneless Claude vetoes
    // even a pi-local record: what a reap can destroy is a directory, and a
    // live Claude in it is fatal whichever runtime the record names.
    //
    // Empty means no PROCESS, not no owner. When two records name this directory
    // the other one may belong to a scratchpad that is still active, and its
    // worktree is merely dormant — pushing and force-removing it on THIS
    // record's archived word destroys a live session's work. So the record is
    // still drained (or the duplication wedges the directory forever), but
    // nothing is destroyed while it is in doubt.
    if (unaccountedPids.length === 0) {
      return conflict.length > 0 ? { kind: "drain", reason: conflictReason(link, conflict) } : { kind: "none" }
    }
    return {
      kind: "refuse",
      status: "skipped occupied",
      reason: `Claude is still running in ${link.worktree} with no pane (pid ${unaccountedPids.join(", ")})`,
    }
  }

  // Something is alive in there, so identity now decides whether killing it is
  // this record's business. Ranking the rungs is right for a read and wrong
  // here: a minted record that outranks an ambiguous ledger would resolve a pane
  // declaring nothing to THIS record's session, and the branch below would kill
  // that window and force-remove the directory a live, differently-identified
  // Claude is using.
  //
  // Deliberately BELOW the empty branch. Duplicate records come from
  // `recordHarnessLink` superseding by raw string compare while every reader
  // canonicalizes, so one trailing slash creates this state — and refusing an
  // EMPTY worktree would wedge it out of reaping forever, because `reapLink` is
  // the only thing that clears a record. Nothing is at risk when nothing is
  // there, and reaping one record per pass is what resolves the duplication.
  if (conflict.length > 0) {
    return { kind: "refuse", status: "skipped ambiguous", reason: conflictReason(link, conflict) }
  }

  const resolved = resolveManagedAgentPane(
    {
      runtime: link.runtimeKind === "pi-local" ? "pi" : "claude",
      runtimeSessionId: link.runtimeSessionId,
      worktree: link.worktree,
    },
    panes,
    undefined,
    undefined,
    deps.links,
    deps.identities,
    deps.canonicalPath
  )
  if (resolved.status === "found" && occupants.length === 1 && resolved.pane.paneId === occupants[0]!.paneId) {
    // The pane's own Claude is `panePid` (the same equivalence `reconnect`
    // relies on). Any other live pid in the directory is a session killing this
    // window would not stop.
    const strangers = unaccountedPids.filter((pid) => pid !== resolved.pane.panePid)
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

  const panes = deps.panes()
  const window = decideWindow(link, panes, deps)
  if (window.kind === "refuse") return { ...base, status: window.status, detail: window.reason }

  // Drop the record, touch nothing else. Leaving it would wedge the directory
  // out of reaping forever, since this is the only pass that clears a record.
  if (window.kind === "drain") {
    if (!dryRun) deps.forgetLink(link.runtimeSessionId)
    return { ...base, status: "drained contested record", detail: window.reason }
  }

  if (!deps.pathExists(link.worktree)) {
    // Already gone — the records are the only leftover.
    if (!dryRun) {
      deps.forgetLink(link.runtimeSessionId)
      retireIdentities(link.worktree, deps)
    }
    return { ...base, status: "skipped worktree missing" }
  }

  if (dryRun) return { ...base, status: "would reap", detail: why }

  const outcome = await windDownLinkedWorktree(link, window, panes, deps)
  if (outcome.refused !== undefined) {
    return { ...base, status: "skipped teardown failed", detail: outcome.refused }
  }
  return {
    ...base,
    status: outcome.removed ? "reaped" : "reaped, worktree left",
    detail: `pushed=${outcome.pushed}${outcome.reason ? ` (${outcome.reason})` : ""}${window.kind === "kill" ? ` window=${window.pane.windowId}` : ""}`,
  }
}

/**
 * Commit/push and remove a worktree a link record owns: teardown → kill the
 * pane and wait for it to exit → wind down → forget the link → retire
 * identities. Shared by the archive-driven reaper and the opt-in `done`
 * command, which both hold `resume-active.lock` across the same sequence.
 *
 * The window goes either way: the session is over even when the cleanup
 * refuses (detached HEAD, unpushable branch) — a refusal leaves the worktree
 * on disk for a human, nothing is lost. Killing goes FIRST because the
 * wind-down removes the directory synchronously and the pane's shell sits in
 * it: `tmux kill-window` returns once it has delivered the signal, not once
 * the process is gone, and removing the directory in that gap deletes the cwd
 * of a Claude still flushing its transcript.
 *
 * Teardown is arbitrary user commands, so it is NOT a rung on the ladder — it
 * runs one level up, before the window is killed and before anything is
 * pushed or removed. A failure refuses the whole wind-down (`refused` set,
 * nothing else touched): a teardown that did not run is not a teardown with
 * nothing to do.
 */
export async function windDownLinkedWorktree(
  link: HarnessLink,
  window: WindDownWindow,
  panes: LocalTmuxPane[],
  deps: WindDownDeps
): Promise<{ removed: boolean; pushed: boolean; reason?: string; refused?: string }> {
  const profile = deps.profileFor(link.worktree, linkRuntimeKind(link))
  const teardown = deps.teardown(link.worktree, profile.teardown)
  if (!teardown.ok) {
    return { removed: false, pushed: false, refused: teardown.reason ?? "teardown failed" }
  }

  if (window.kind === "kill") {
    deps.killWindow(window.pane.windowId)
    await deps.awaitExit(window.pane.panePid)
  }
  const shared = sharedDirectoryClaimants(link, panes, deps)
  if (shared.length > 0) {
    deps.log(`${link.worktree}: shared with ${shared.join(", ")}; leaving the directory and its branch untouched`)
  }
  const report = deps.windDown(
    link.worktree,
    (message) => deps.log(`${link.worktree}: ${message}`),
    shared.length > 0 ? { preserve: "none", reclaim: false } : windDownPolicyFor(profile)
  )
  // Forgotten either way, matching the pre-existing contract for a refused
  // wind-down: the branch is the thing that had to survive, and a directory
  // left behind is for a human. What must not happen is reporting it gone.
  deps.forgetLink(link.runtimeSessionId)
  // The identity record is retired only when the directory actually went away.
  // A wind-down that refused left the worktree on disk, and the identity is
  // still that directory's — retiring it would let the next mint hand the same
  // live directory a second id.
  if (report.removed) retireIdentities(link.worktree, deps)
  return { removed: report.removed, pushed: report.pushed, reason: report.reason }
}

export function retireIdentities(worktree: string, deps: Pick<ReapDeps, "forgetIdentities" | "log">): void {
  const retired = deps.forgetIdentities(worktree)
  if (retired.length > 0) deps.log(`${worktree}: retired identity ${retired.join(", ")}`)
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
