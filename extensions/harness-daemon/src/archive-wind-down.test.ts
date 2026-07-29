import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_WIND_DOWN_POLICY, pushBranchAndRemoveWorktree } from "./archive-wind-down"

const noLog = () => undefined

function sh(cwd: string, command: string): string {
  const result = Bun.spawnSync(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`'${command}' failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

/** A main repo on a feature branch with a bare `origin`, plus a linked worktree. */
function makeFixture(): { main: string; worktree: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "archive-wind-down-"))
  const origin = join(root, "origin.git")
  const main = join(root, "main")
  sh(root, `git init --bare origin.git`)
  sh(root, `git init -b main main`)
  sh(main, `git config user.email t@t && git config user.name t`)
  writeFileSync(join(main, "a.txt"), "a\n")
  sh(main, `git add -A && git commit -m init`)
  sh(main, `git remote add origin ${origin}`)
  sh(main, `git push -u origin main`)
  const worktree = join(root, "wt-feature")
  sh(main, `git worktree add -b feature/archive-test ${worktree}`)
  sh(worktree, `git config user.email t@t && git config user.name t`)
  return { main, worktree, origin }
}

function originHasBranch(origin: string, branch: string): boolean {
  const result = Bun.spawnSync(["git", "-C", origin, "rev-parse", "--verify", `refs/heads/${branch}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return result.exitCode === 0
}

describe("pushBranchAndRemoveWorktree", () => {
  test("commits dirty work, pushes the branch, and removes the linked worktree before returning", () => {
    // Synchronous by contract: the caller holds `resume-active.lock`, so a
    // removal that outlived the return could delete a worktree a revive had
    // already recreated under the lock.
    const { worktree, origin } = makeFixture()
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")

    const report = pushBranchAndRemoveWorktree(worktree, noLog)

    expect(report).toMatchObject({ committed: true, pushed: true, removed: true })
    expect(existsSync(worktree)).toBe(false)
    expect(originHasBranch(origin, "feature/archive-test")).toBe(true)
    const pushedMessage = sh(origin, `git log -1 --format=%s feature/archive-test`)
    expect(pushedMessage).toBe("wip: auto-commit — scratchpad archived")
  })

  test("pushes a clean worktree without inventing a commit", () => {
    const { worktree, origin } = makeFixture()
    const report = pushBranchAndRemoveWorktree(worktree, noLog)
    expect(report.committed).toBe(false)
    expect(report.pushed).toBe(true)
    expect(originHasBranch(origin, "feature/archive-test")).toBe(true)
  })

  test("leaves the worktree when the push fails (no remote)", () => {
    const { main, worktree } = makeFixture()
    sh(main, `git remote remove origin`)
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")

    const report = pushBranchAndRemoveWorktree(worktree, noLog)

    expect(report.pushed).toBe(false)
    expect(report.removed).toBe(false)
    expect(report.reason).toContain("push failed")
    // Committed (preserving the work) but still on disk.
    expect(existsSync(join(worktree, "wip.txt"))).toBe(true)
  })

  test("refuses to touch main and never removes the main checkout", () => {
    const { main } = makeFixture()
    const report = pushBranchAndRemoveWorktree(main, noLog)
    expect(report.pushed).toBe(false)
    expect(report.removed).toBe(false)
    expect(report.reason).toContain("protected")
  })

  test("pushes from the main checkout on a feature branch but does not remove it", () => {
    const { main, origin } = makeFixture()
    sh(main, `git checkout -b feature/from-main`)
    const report = pushBranchAndRemoveWorktree(main, noLog)
    expect(report.pushed).toBe(true)
    expect(report.removed).toBe(false)
    expect(report.reason).toContain("main repository checkout")
    expect(originHasBranch(origin, "feature/from-main")).toBe(true)
  })

  test("a blocking pre-commit hook does not stop the work being preserved", () => {
    // Threa's own hook runs a monorepo lint + typecheck that takes minutes;
    // without --no-verify every dirty worktree failed to commit and the
    // "nothing dies with the worktree" promise silently never happened.
    const { worktree, origin } = makeFixture()
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")
    // A linked worktree reads hooks from the repo's COMMON dir, not its own
    // gitdir — putting them in the gitdir is a hook that never runs.
    const commonDir = sh(worktree, "git rev-parse --path-format=absolute --git-common-dir")
    const hooks = join(commonDir, "hooks")
    mkdirSync(hooks, { recursive: true })
    const hook = join(hooks, "pre-commit")
    writeFileSync(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n")
    chmodSync(hook, 0o755)

    const report = pushBranchAndRemoveWorktree(worktree, noLog)

    expect(report).toMatchObject({ committed: true, pushed: true })
    expect(sh(origin, `git log -1 --format=%s feature/archive-test`)).toBe("wip: auto-commit — scratchpad archived")
  })

  test("a git status that cannot run is not proof of a clean tree", () => {
    // A corrupt index makes `status --porcelain` exit non-zero with empty
    // stdout. Reading that as "clean" would skip the commit, push the old
    // HEAD, and let --force delete work that was never saved.
    const { worktree, origin } = makeFixture()
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")
    const gitDir = sh(worktree, "git rev-parse --path-format=absolute --git-dir")
    writeFileSync(join(gitDir, "index"), "not an index\n")

    const report = pushBranchAndRemoveWorktree(worktree, noLog)

    expect(report).toMatchObject({ committed: false, pushed: false, removed: false })
    expect(report.reason).toContain("could not read worktree status")
    expect(originHasBranch(origin, "feature/archive-test")).toBe(false)
    expect(existsSync(join(worktree, "wip.txt"))).toBe(true)
  })

  test("reports a non-repo directory without doing anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"))
    const report = pushBranchAndRemoveWorktree(dir, noLog)
    expect(report).toMatchObject({ committed: false, pushed: false, removed: false })
    expect(report.reason).toContain("not a git worktree")
  })
})

/**
 * The rung is an ordinal CEILING on the one fixed sequence, so a policy can only
 * stop earlier. Every test above runs with no third argument — that is the
 * regression guard proving the default is byte-identical to the pre-profile
 * behaviour, and it is deliberately not restated here.
 */
describe("pushBranchAndRemoveWorktree under a preserve ceiling", () => {
  test("the default policy is byte-identical to the pre-profile behaviour", () => {
    const defaulted = makeFixture()
    writeFileSync(join(defaulted.worktree, "wip.txt"), "unsaved work\n")
    const explicit = makeFixture()
    writeFileSync(join(explicit.worktree, "wip.txt"), "unsaved work\n")

    expect(pushBranchAndRemoveWorktree(defaulted.worktree, noLog)).toEqual(
      pushBranchAndRemoveWorktree(explicit.worktree, noLog, DEFAULT_WIND_DOWN_POLICY)
    )
    expect(existsSync(defaulted.worktree)).toBe(false)
    expect(existsSync(explicit.worktree)).toBe(false)
  })

  test("preserve: none leaves the branch unpushed and the worktree on disk, with a reason", () => {
    const { worktree, origin } = makeFixture()
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")

    const report = pushBranchAndRemoveWorktree(worktree, noLog, { preserve: "none", reclaim: false })

    expect(report).toMatchObject({ committed: false, pushed: false, removed: false })
    expect(report.reason).toContain("preserve 'none'")
    expect(originHasBranch(origin, "feature/archive-test")).toBe(false)
    expect(existsSync(join(worktree, "wip.txt"))).toBe(true)
  })

  test("preserve: commit saves the dirty tree and stops before the push", () => {
    const { worktree, origin } = makeFixture()
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")

    const report = pushBranchAndRemoveWorktree(worktree, noLog, { preserve: "commit", reclaim: false })

    expect(report).toMatchObject({ committed: true, pushed: false, removed: false })
    expect(sh(worktree, "git log -1 --format=%s")).toBe("wip: auto-commit — scratchpad archived")
    expect(originHasBranch(origin, "feature/archive-test")).toBe(false)
    expect(existsSync(worktree)).toBe(true)
  })

  test("reclaim never runs without a successful push, whatever the rung", () => {
    // {preserve: "commit", reclaim: true} is unrepresentable in a Profile and
    // rejected at config time; the ladder is the second line of defence, and it
    // returns before `push` ever runs, so the removal block is unreachable.
    const { worktree, origin } = makeFixture()
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")

    const report = pushBranchAndRemoveWorktree(worktree, noLog, { preserve: "commit", reclaim: true })

    expect(report).toMatchObject({ committed: true, pushed: false, removed: false })
    expect(existsSync(join(worktree, "wip.txt"))).toBe(true)
    expect(originHasBranch(origin, "feature/archive-test")).toBe(false)
  })

  test("reclaim: false pushes and keeps the directory", () => {
    const { worktree, origin } = makeFixture()
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")

    const report = pushBranchAndRemoveWorktree(worktree, noLog, { preserve: "commit+push", reclaim: false })

    expect(report).toMatchObject({ committed: true, pushed: true, removed: false })
    expect(report.reason).toContain("reclaim is off")
    expect(originHasBranch(origin, "feature/archive-test")).toBe(true)
    expect(existsSync(worktree)).toBe(true)
  })

  test("a protected branch still refuses at the highest rung — the floor is not a policy input", () => {
    const { main } = makeFixture()
    const report = pushBranchAndRemoveWorktree(main, noLog, { preserve: "commit+push", reclaim: true })
    expect(report).toMatchObject({ committed: false, pushed: false, removed: false })
    expect(report.reason).toContain("protected")
    expect(existsSync(main)).toBe(true)
  })

  test("the main checkout is never removed, whatever the policy", () => {
    const { main, origin } = makeFixture()
    sh(main, `git checkout -b feature/from-main`)
    const report = pushBranchAndRemoveWorktree(main, noLog, { preserve: "commit+push", reclaim: true })
    expect(report).toMatchObject({ pushed: true, removed: false })
    expect(report.reason).toContain("main repository checkout")
    expect(originHasBranch(origin, "feature/from-main")).toBe(true)
    expect(existsSync(main)).toBe(true)
  })
})
