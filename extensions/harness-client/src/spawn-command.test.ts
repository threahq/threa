import { describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { parseSpawnCommandArgs, writeSpawnBrief } from "./spawn-command"

const USAGE = "Usage: `/spawn [claude|pi] <name>` with the prompt on the following lines."
const BOTH = [
  { value: "claude", label: "Claude Code", installed: true },
  { value: "pi", label: "Pi", installed: true },
]
const PI_ONLY = [
  { value: "claude", label: "Claude Code", installed: false },
  { value: "pi", label: "Pi", installed: true },
]
const parse = (args: string, runtimes = BOTH, defaultRuntime = "claude") =>
  parseSpawnCommandArgs(args, { runtimes, defaultRuntime })

describe("parseSpawnCommandArgs", () => {
  it("takes a leading runtime token, the rest of the line as the name and the rest as the prompt", () => {
    expect(parse("pi fix sidebar\nDo X\nthen Y")).toEqual({
      runtime: "pi",
      name: "fix sidebar",
      prompt: "Do X\nthen Y",
    })
  })

  it("reads CRLF input the same as LF", () => {
    expect(parse("pi fix sidebar\r\nDo X\r\nthen Y")).toEqual({
      runtime: "pi",
      name: "fix sidebar",
      prompt: "Do X\nthen Y",
    })
  })

  it("falls back to the default runtime when the first token is a name", () => {
    expect(parse("fix sidebar")).toEqual({ runtime: "claude", name: "fix sidebar", prompt: "" })
  })

  it("rejects a missing name, runtime token or not", () => {
    expect(parse("")).toEqual({ error: USAGE })
    expect(parse("pi")).toEqual({ error: USAGE })
    expect(parse("  \nDo X")).toEqual({ error: USAGE })
  })

  it("rejects a name token that would reach harnessd as a flag", () => {
    expect(parse("claude --force fix sidebar")).toEqual({ error: USAGE })
  })

  it("refuses a runtime harnessd knows but this machine lacks instead of folding it into the name", () => {
    expect(parse("claude fix", PI_ONLY, "pi")).toEqual({
      error: "`claude` is not installed on this machine. Installed: pi.",
    })
  })

  it("refuses the default runtime when it is the one missing", () => {
    expect(parse("fix sidebar", PI_ONLY, "claude")).toEqual({
      error: "`claude` is not installed on this machine. Installed: pi.",
    })
  })

  it("treats a first token no runtime is called as the name", () => {
    expect(parse("codex fix", PI_ONLY, "pi")).toEqual({ runtime: "pi", name: "codex fix", prompt: "" })
  })

  it("lists only the installed runtimes in the usage line", () => {
    expect(parse("", PI_ONLY, "pi")).toEqual({
      error: "Usage: `/spawn [pi] <name>` with the prompt on the following lines.",
    })
  })

  it("names the missing default without a list when nothing is installed", () => {
    expect(parse("fix", [], "claude")).toEqual({ error: "`claude` is not installed on this machine." })
  })
})

describe("writeSpawnBrief", () => {
  it("writes the prompt to a private file directly under the base directory, creating no directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-brief-test-"))
    const path = writeSpawnBrief("Do X\nthen Y", { dir })

    expect({
      content: readFileSync(path, "utf8"),
      mode: statSync(path).mode & 0o777,
      parent: dirname(path),
      entries: readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      })),
    }).toEqual({
      content: "Do X\nthen Y",
      mode: 0o600,
      parent: dir,
      entries: [{ name: basename(path), directory: false }],
    })
  })

  it("never reuses a path between calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-brief-test-"))
    expect(writeSpawnBrief("first", { dir })).not.toBe(writeSpawnBrief("second", { dir }))
  })
})
