import { describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { parseSpawnCommandArgs, writeSpawnBrief } from "./spawn-command"

const USAGE = "Usage: `/spawn [claude|pi] <name>` with the prompt on the following lines."

describe("parseSpawnCommandArgs", () => {
  it("takes a leading runtime token, the rest of the line as the name and the rest as the prompt", () => {
    expect(parseSpawnCommandArgs("claude fix sidebar\nDo X\nthen Y")).toEqual({
      runtime: "claude",
      name: "fix sidebar",
      prompt: "Do X\nthen Y",
    })
  })

  it("reads CRLF input the same as LF", () => {
    expect(parseSpawnCommandArgs("claude fix sidebar\r\nDo X\r\nthen Y")).toEqual({
      runtime: "claude",
      name: "fix sidebar",
      prompt: "Do X\nthen Y",
    })
  })

  it("leaves the runtime unset when the first token is a name", () => {
    expect(parseSpawnCommandArgs("fix sidebar")).toEqual({ name: "fix sidebar", prompt: "" })
  })

  it("rejects a missing name, runtime token or not", () => {
    expect(parseSpawnCommandArgs("")).toEqual({ error: USAGE })
    expect(parseSpawnCommandArgs("pi")).toEqual({ error: USAGE })
    expect(parseSpawnCommandArgs("  \nDo X")).toEqual({ error: USAGE })
  })

  it("rejects a name token that would reach harnessd as a flag", () => {
    expect(parseSpawnCommandArgs("claude --force fix sidebar")).toEqual({ error: USAGE })
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
