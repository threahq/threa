import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pushBranchAndScheduleRemoval } from "./archive-wind-down"

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

describe("pushBranchAndScheduleRemoval", () => {
  test("commits dirty work, pushes the branch, and schedules removal of a linked worktree", async () => {
    const { worktree, origin } = makeFixture()
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")

    const report = pushBranchAndScheduleRemoval(worktree, noLog)

    expect(report).toMatchObject({ committed: true, pushed: true, removalScheduled: true })
    expect(originHasBranch(origin, "feature/archive-test")).toBe(true)
    const pushedMessage = sh(origin, `git log -1 --format=%s feature/archive-test`)
    expect(pushedMessage).toBe("wip: auto-commit — scratchpad archived")
    // The detached remover fires after its 5s grace; poll briefly for it.
    const { existsSync } = await import("node:fs")
    const deadline = Date.now() + 10_000
    while (existsSync(worktree) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(existsSync(worktree)).toBe(false)
  }, 20_000)

  test("pushes a clean worktree without inventing a commit", () => {
    const { worktree, origin } = makeFixture()
    const report = pushBranchAndScheduleRemoval(worktree, noLog)
    expect(report.committed).toBe(false)
    expect(report.pushed).toBe(true)
    expect(originHasBranch(origin, "feature/archive-test")).toBe(true)
  })

  test("leaves the worktree when the push fails (no remote)", async () => {
    const { main, worktree } = makeFixture()
    sh(main, `git remote remove origin`)
    writeFileSync(join(worktree, "wip.txt"), "unsaved work\n")

    const report = pushBranchAndScheduleRemoval(worktree, noLog)

    expect(report.pushed).toBe(false)
    expect(report.removalScheduled).toBe(false)
    expect(report.reason).toContain("push failed")
    // Committed (preserving the work) but still on disk well past any grace delay.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const { existsSync } = await import("node:fs")
    expect(existsSync(join(worktree, "wip.txt"))).toBe(true)
  })

  test("refuses to touch main and never removes the main checkout", () => {
    const { main } = makeFixture()
    const report = pushBranchAndScheduleRemoval(main, noLog)
    expect(report.pushed).toBe(false)
    expect(report.removalScheduled).toBe(false)
    expect(report.reason).toContain("protected")
  })

  test("pushes from the main checkout on a feature branch but does not remove it", () => {
    const { main, origin } = makeFixture()
    sh(main, `git checkout -b feature/from-main`)
    const report = pushBranchAndScheduleRemoval(main, noLog)
    expect(report.pushed).toBe(true)
    expect(report.removalScheduled).toBe(false)
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

    const report = pushBranchAndScheduleRemoval(worktree, noLog)

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

    const report = pushBranchAndScheduleRemoval(worktree, noLog)

    expect(report).toMatchObject({ committed: false, pushed: false, removalScheduled: false })
    expect(report.reason).toContain("could not read worktree status")
    expect(originHasBranch(origin, "feature/archive-test")).toBe(false)
    expect(existsSync(join(worktree, "wip.txt"))).toBe(true)
  })

  test("reports a non-repo directory without doing anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"))
    const report = pushBranchAndScheduleRemoval(dir, noLog)
    expect(report).toMatchObject({ committed: false, pushed: false, removalScheduled: false })
    expect(report.reason).toContain("not a git worktree")
  })
})
