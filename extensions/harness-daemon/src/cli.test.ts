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

test("--attach and --anchor together parse into attach", () => {
  const options = parseSpawn(["claude", "--name", "a", "--attach", "stream_root", "--anchor", "msg_anchor"])
  expect(options.attach).toEqual({ rootStreamId: "stream_root", anchorId: "msg_anchor" })
})

test("--attach without --anchor dies naming the missing flag", () => {
  expect(() => parseSpawn(["claude", "--name", "a", "--attach", "stream_root"])).toThrow(
    "--attach requires --anchor <anchor-id>"
  )
})

test("--anchor without --attach dies naming the missing flag", () => {
  expect(() => parseSpawn(["claude", "--name", "a", "--anchor", "msg_anchor"])).toThrow(
    "--anchor requires --attach <root-stream-id>"
  )
})

test("neither --attach nor --anchor leaves attach undefined", () => {
  expect(parseSpawn(["claude", "--name", "a"]).attach).toBeUndefined()
})

test("--brief-file without --attach dies naming the missing flag", () => {
  expect(() => parseSpawn(["claude", "--name", "a", "--brief-file", "/tmp/brief.md"])).toThrow(
    "--brief-file requires --attach"
  )
})

test("--brief-file with --attach parses into briefFile", () => {
  const options = parseSpawn([
    "claude",
    "--name",
    "a",
    "--attach",
    "stream_root",
    "--anchor",
    "msg_anchor",
    "--brief-file",
    "/tmp/brief.md",
  ])
  expect(options.briefFile).toBe("/tmp/brief.md")
})
