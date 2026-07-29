import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plannedWorktreePath } from "./worktree"

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
