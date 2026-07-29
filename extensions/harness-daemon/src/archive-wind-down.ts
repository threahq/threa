import { spawnSync } from "node:child_process"
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
 *   3. push succeeded AND this is a linked worktree → `git worktree remove
 *      --force`, synchronously
 *
 * Never touches `main`/`master`/detached HEAD, and never removes the main
 * repository checkout — only linked worktrees.
 *
 * This lives in harnessd, not in the runtimes' shared client library, and has
 * exactly one caller: {@link reapLink}, which holds `resume-active.lock`. A
 * revive can be recreating the very worktree this would force-remove, and the
 * two race the server independently — so the destructive half of the wind-down
 * belongs where that lock is held. A runtime that decides to wind down marks
 * its link record (`windDownRequestedAt`) and exits instead. That is also why
 * the removal is synchronous: deferring it past the return deferred it past the
 * lock too, so a revive that acquired the lock inside the delay could recreate
 * the worktree and then watch it disappear. The caller kills the occupying tmux
 * window BEFORE calling this, so nothing is left holding the directory.
 */

export interface ArchiveCleanupReport {
  committed: boolean
  pushed: boolean
  removed: boolean
  reason?: string
}

/**
 * The ladder's rungs, in the only order they may run. A policy is an ordinal
 * CEILING on this sequence, never a set of per-step toggles: a caller can stop
 * earlier, and has no way to reorder, skip, or raise. The floors below —
 * protected/detached branch, unreadable status, main-checkout-never-removed —
 * live inside the function and are not policy inputs.
 */
export const PRESERVE_RUNGS = ["none", "commit", "commit+push"] as const
export type PreserveRung = (typeof PRESERVE_RUNGS)[number]

export interface WindDownPolicy {
  preserve: PreserveRung
  reclaim: boolean
}

export const DEFAULT_WIND_DOWN_POLICY: WindDownPolicy = { preserve: "commit+push", reclaim: true }

function rung(preserve: PreserveRung): number {
  return PRESERVE_RUNGS.indexOf(preserve)
}

const PROTECTED_BRANCHES = new Set(["main", "master", "HEAD"])
const GIT_TIMEOUT_MS = 30_000
// Staging + writing a commit for a large dirty tree is slower than a plain
// query, and this one must not be the thing that loses the work.
const COMMIT_TIMEOUT_MS = 120_000
const PUSH_TIMEOUT_MS = 120_000
// Removing a large worktree is filesystem-bound, and this runs while
// `resume-active.lock` is held — a hang here blocks every revive.
const REMOVE_TIMEOUT_MS = 120_000

function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs })
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() }
  } catch {
    return { ok: false, stdout: "" }
  }
}

export function pushBranchAndRemoveWorktree(
  cwd: string,
  log: (message: string) => void,
  policy: WindDownPolicy = DEFAULT_WIND_DOWN_POLICY
): ArchiveCleanupReport {
  const report: ArchiveCleanupReport = { committed: false, pushed: false, removed: false }

  if (!git(cwd, ["rev-parse", "--is-inside-work-tree"]).ok) {
    report.reason = "not a git worktree"
    return report
  }
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout
  if (!branch || PROTECTED_BRANCHES.has(branch)) {
    report.reason = `branch '${branch || "?"}' is protected or detached — leaving everything as is`
    return report
  }

  if (rung(policy.preserve) < rung("commit")) {
    report.reason = `preserve '${policy.preserve}' — leaving the branch and the worktree exactly as they are`
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

  if (rung(policy.preserve) < rung("commit+push")) {
    report.reason = `preserve '${policy.preserve}' — the work is committed locally and nothing is pushed or removed`
    return report
  }

  const push = git(cwd, ["push", "-u", "origin", `HEAD:${branch}`], PUSH_TIMEOUT_MS)
  if (!push.ok) {
    report.reason = "push failed — leaving the worktree so nothing is lost"
    return report
  }
  report.pushed = true
  log(`pushed ${branch} to origin`)

  if (!policy.reclaim) {
    report.reason = "reclaim is off for this profile — the branch is pushed and the directory stays"
    return report
  }

  // Linked worktree ⇔ its .git dir differs from the repo's common dir. The
  // main checkout's dir IS the common dir, so this can never remove it.
  const gitDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]).stdout
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout
  if (!gitDir || !commonDir || resolve(gitDir) === resolve(commonDir)) {
    report.reason = "main repository checkout — not removing"
    return report
  }

  const mainRepo = dirname(resolve(commonDir))
  const removal = git(mainRepo, ["worktree", "remove", "--force", cwd], REMOVE_TIMEOUT_MS)
  if (!removal.ok) {
    report.reason = "could not remove the worktree (branch is pushed; remove manually)"
    return report
  }
  report.removed = true
  return report
}
