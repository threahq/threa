import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plannedWorktreePath, provisionWorkspace, runTeardownCommands } from "./worktree"
import { DEFAULT_PROFILE, type Profile } from "./profiles"

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harnessd-worktree-")))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test("the planned path is the sibling of the repo, named for the agent", () => {
  mkdirSync(join(root, "threa"), { recursive: true })

  expect(plannedWorktreePath({ runtime: "claude", name: "feature", repo: join(root, "threa") })).toBe(
    join(root, "threa.feature")
  )
})

/**
 * The mint records this path before the directory exists, and every later reader
 * resolves the directory that does exist. Canonicalizing the whole path would
 * throw on the absent leaf and fall back to the raw one, so the two would never
 * compare equal on a machine whose checkout sits behind a symlink.
 */
test("a repo reached through a symlink plans the resolved path, not the link path", () => {
  mkdirSync(join(root, "real", "threa"), { recursive: true })
  symlinkSync(join(root, "real"), join(root, "link"))

  expect(plannedWorktreePath({ runtime: "claude", name: "feature", repo: join(root, "link", "threa") })).toBe(
    join(root, "real", "threa.feature")
  )
})

function repoAt(path: string): void {
  mkdirSync(path, { recursive: true })
  const origin = `${path}.origin.git`
  Bun.spawnSync(["git", "init", "--bare", origin], { stdout: "pipe", stderr: "pipe" })
  for (const command of ["git init -b main .", "git config user.email t@t", "git config user.name t"]) {
    const result = Bun.spawnSync(["sh", "-c", command], { cwd: path, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr.toString()}`)
  }
  writeFileSync(join(path, "a.txt"), "a\n")
  for (const command of [
    "git add -A && git commit -m init",
    `git remote add origin ${origin}`,
    "git push -u origin main",
  ]) {
    const result = Bun.spawnSync(["sh", "-c", command], { cwd: path, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr.toString()}`)
  }
}

const EXISTING: Profile = {
  name: "here",
  provision: "existing",
  preserve: "commit+push",
  setup: [],
  teardown: [],
}

test("the existing provisioner uses the given directory and creates nothing", () => {
  const dir = join(root, "orchestrator")
  mkdirSync(dir, { recursive: true })

  const result = provisionWorkspace({ runtime: "pi", name: "orchestrator", cwd: dir }, EXISTING)

  expect(result.worktree).toBe(dir)
  expect(readdirSync(root).sort()).toEqual(["orchestrator"])
})

test("the existing provisioner refuses a directory that does not exist", () => {
  expect(() => provisionWorkspace({ runtime: "pi", name: "gone", cwd: join(root, "nope") }, EXISTING)).toThrow(
    /directory not found/
  )
})

test("the existing provisioner names a branch for a directory that is not a repo", () => {
  // The Pi orchestrator directory is not a git repo, and SpawnResult.branch is required.
  const dir = join(root, "orchestrator")
  mkdirSync(dir, { recursive: true })
  expect(provisionWorkspace({ runtime: "pi", name: "orchestrator", cwd: dir }, EXISTING).branch).toBe("orchestrator")
})

test("the existing provisioner takes the checked-out branch when the directory is a repo", () => {
  const dir = join(root, "repo")
  repoAt(dir)
  expect(provisionWorkspace({ runtime: "pi", name: "anything", cwd: dir }, EXISTING).branch).toBe("main")
})

test("a worktree profile cannot be pointed at an existing directory", () => {
  expect(() => provisionWorkspace({ runtime: "claude", name: "f", cwd: join(root, "x") }, DEFAULT_PROFILE)).toThrow(
    /--cwd cannot apply/
  )
})

test("the worktree provisioner honours a profile's layout and base", () => {
  const repo = join(root, "threa")
  repoAt(repo)
  const profile: Profile = {
    name: "custom",
    provision: "worktree",
    layout: "wt-${repo}-${name}",
    base: "main",
    setup: [],
    teardown: [],
    preserve: "commit+push",
    reclaim: true,
  }

  const planned = plannedWorktreePath({ runtime: "claude", name: "feature", repo }, profile)

  expect(planned).toBe(join(root, "wt-threa-feature"))
  const result = provisionWorkspace({ runtime: "claude", name: "feature", repo, branch: "feature/x" }, profile)
  expect(result).toEqual({ worktree: planned, branch: "feature/x" })
  expect(existsSync(join(planned, "a.txt"))).toBe(true)
})

test("a layout that escapes the repo's parent is refused before anything is created", () => {
  const repo = join(root, "threa")
  repoAt(repo)
  const escaping = {
    name: "bad",
    provision: "worktree",
    layout: "../../${name}",
    base: "main",
    setup: [],
    teardown: [],
    preserve: "commit+push",
    reclaim: true,
  } as Profile

  expect(() => plannedWorktreePath({ runtime: "claude", name: "f", repo }, escaping)).toThrow(/resolves outside/)
})

test("teardown commands are bounded and a failure is reported rather than swallowed", () => {
  const dir = join(root, "td")
  mkdirSync(dir, { recursive: true })
  expect(runTeardownCommands(dir, [])).toEqual({ ok: true })
  expect(runTeardownCommands(dir, ["true"])).toEqual({ ok: true })
  const failed = runTeardownCommands(dir, ["exit 3"])
  expect(failed.ok).toBe(false)
  expect(failed.reason).toContain("exit code 3")
})

test("a teardown that ignores SIGTERM is still killed, and reported", () => {
  // spawnSync's timeout signals but does not escalate, so without killSignal a
  // command that traps TERM holds `resume-active.lock` for as long as it likes.
  const dir = join(root, "trap")
  mkdirSync(dir, { recursive: true })

  const startedAt = Date.now()
  const result = runTeardownCommands(dir, ["trap '' TERM; sleep 30"], 500)

  expect(result.ok).toBe(false)
  expect(result.reason).toMatch(/timed out or was killed|ETIMEDOUT/)
  expect(Date.now() - startedAt).toBeLessThan(10_000)
})
