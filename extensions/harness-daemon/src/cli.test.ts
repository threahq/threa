import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseSpawn } from "./cli"

test("--cwd together with --repo, --branch or --base is refused at parse time", () => {
  // --cwd provisions nothing, so there is nothing to create a branch off and
  // nothing to create it in. Accepting both would silently ignore one.
  for (const [flag, value] of [
    ["--repo", "/somewhere"],
    ["--branch", "feature/x"],
    ["--base", "origin/main"],
  ]) {
    expect(() => parseSpawn(["claude", "--name", "a", "--cwd", "/tmp", flag!, value!])).toThrow(
      new RegExp(`--cwd provisions nothing.*\\${flag}`)
    )
  }
})

test("--cwd is resolved and records no repo", () => {
  const options = parseSpawn(["claude", "--name", "orchestrator", "--cwd", "."])
  expect(options.cwd).toBe(resolve("."))
  expect(options.repo).toBeUndefined()
})

test("--profile is carried through, and its absence is not a name", () => {
  expect(parseSpawn(["claude", "--name", "a", "--profile", "pi-orchestrator"]).profile).toBe("pi-orchestrator")
  expect(parseSpawn(["claude", "--name", "a"]).profile).toBeUndefined()
})

test("without --cwd the repo still defaults, exactly as before", () => {
  expect(parseSpawn(["claude", "--name", "a"]).repo).toBeTruthy()
})
