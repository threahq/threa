import { spawn, spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"

/**
 * Wind-down for an archived scratchpad: preserve the work on the remote, then
 * clean up the local footprint. The safety ladder is strict — each rung only
 * runs when the one before it succeeded, and anything short of a successful
 * push leaves the worktree untouched on disk:
 *
 *   1. dirty tree → `git add -A` + a wip commit (uncommitted work must never
 *      die with the worktree)
 *   2. `git push origin HEAD:<branch>`
 *   3. push succeeded AND this is a linked worktree → schedule removal via a
 *      detached shell (this process dies with its tmux window moments later,
 *      so the removal must outlive it)
 *
 * Never touches `main`/`master`/detached HEAD, and never removes the main
 * repository checkout — only linked worktrees.
 */

/**
 * How long a runtime survives its scratchpad being archived before winding
 * down. An unarchive inside this window reattaches the live agent in place.
 * Shared: Claude (`@threa/remote-session`) and Pi run separate session
 * implementations, and a grace tuned on one must not diverge from the other.
 */
export const ARCHIVE_RESTORE_GRACE_MS = 5 * 60 * 1000
/** Reattach-probe cadence while detached. Bounded by the grace window, so it cannot become a quota burn. */
export const ARCHIVE_RESTORE_PROBE_MS = 45_000

export interface ArchiveCleanupReport {
  committed: boolean
  pushed: boolean
  removalScheduled: boolean
  reason?: string
}

export interface ArchiveWindDownReport extends ArchiveCleanupReport {
  windowKilled: boolean
}

const PROTECTED_BRANCHES = new Set(["main", "master", "HEAD"])
const GIT_TIMEOUT_MS = 30_000
// Staging + writing a commit for a large dirty tree is slower than a plain
// query, and this one must not be the thing that loses the work.
const COMMIT_TIMEOUT_MS = 120_000
const PUSH_TIMEOUT_MS = 120_000

function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs })
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() }
  } catch {
    return { ok: false, stdout: "" }
  }
}

export function pushBranchAndScheduleRemoval(cwd: string, log: (message: string) => void): ArchiveCleanupReport {
  const report: ArchiveCleanupReport = { committed: false, pushed: false, removalScheduled: false }

  if (!git(cwd, ["rev-parse", "--is-inside-work-tree"]).ok) {
    report.reason = "not a git worktree"
    return report
  }
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout
  if (!branch || PROTECTED_BRANCHES.has(branch)) {
    report.reason = `branch '${branch || "?"}' is protected or detached — leaving everything as is`
    return report
  }

  // A failed `status` reads as an empty (clean) tree, which would skip the
  // commit, push the old HEAD, and let --force delete work that was never
  // saved. A diagnostic that did not run is not proof the tree is clean.
  const status = git(cwd, ["status", "--porcelain"])
  if (!status.ok) {
    report.reason = "could not read worktree status — leaving everything as is"
    return report
  }
  if (status.stdout.length > 0) {
    const added = git(cwd, ["add", "-A"])
    // --no-verify: this is an emergency preservation commit of work that is by
    // definition unfinished, so gating it on the project's pre-commit hook is
    // both wrong and fatal. Threa's hook runs a monorepo-wide lint + typecheck
    // that takes minutes, so every dirty worktree failed here and the "nothing
    // dies with the worktree" promise silently never happened.
    const commit = added.ok
      ? git(cwd, ["commit", "--no-verify", "-m", "wip: auto-commit — scratchpad archived"], COMMIT_TIMEOUT_MS)
      : added
    if (!commit.ok) {
      report.reason = "could not commit dirty work — leaving the worktree"
      return report
    }
    report.committed = true
  }

  const push = git(cwd, ["push", "-u", "origin", `HEAD:${branch}`], PUSH_TIMEOUT_MS)
  if (!push.ok) {
    report.reason = "push failed — leaving the worktree so nothing is lost"
    return report
  }
  report.pushed = true
  log(`pushed ${branch} to origin`)

  // Linked worktree ⇔ its .git dir differs from the repo's common dir. The
  // main checkout's dir IS the common dir, so this can never remove it.
  const gitDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]).stdout
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout
  if (!gitDir || !commonDir || resolve(gitDir) === resolve(commonDir)) {
    report.reason = "main repository checkout — not removing"
    return report
  }

  const mainRepo = dirname(resolve(commonDir))
  try {
    // Detached with a grace delay: this process dies with its tmux window
    // moments after returning, and a directory can't be removed out from under
    // the processes still holding it.
    const child = spawn(
      "sh",
      ["-c", `sleep 5; git -C ${shellQuote(mainRepo)} worktree remove --force ${shellQuote(cwd)}`],
      { detached: true, stdio: "ignore" }
    )
    child.unref()
    report.removalScheduled = true
  } catch {
    report.reason = "could not schedule worktree removal (branch is pushed; remove manually)"
  }
  return report
}

function paneTarget(): string | undefined {
  return process.env.THREA_TMUX_TARGET?.trim() || process.env.TMUX_PANE?.trim() || undefined
}

/**
 * Kill the tmux window the runtime lives in — deliberate self-termination for
 * the archived-scratchpad wind-down. The runtime dies with the window, so
 * callers do any last writes first.
 */
export function killOwnWindow(): boolean {
  const target = paneTarget()
  if (!target) return false
  try {
    return spawnSync("tmux", ["kill-window", "-t", target], { encoding: "utf8" }).status === 0
  } catch {
    return false
  }
}

/**
 * The whole archived-scratchpad wind-down for a harness runtime: preserve the
 * work, then take the tmux window down. Outside tmux there is nothing to kill,
 * and the caller decides how to exit.
 */
export function windDownArchivedWorktree(cwd: string, log: (message: string) => void): ArchiveWindDownReport {
  const report = pushBranchAndScheduleRemoval(cwd, log)
  log(
    `archive cleanup: committed=${report.committed} pushed=${report.pushed} removal=${report.removalScheduled}` +
      (report.reason ? ` (${report.reason})` : "")
  )
  return { ...report, windowKilled: killOwnWindow() }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
