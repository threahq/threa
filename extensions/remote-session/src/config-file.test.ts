import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readConfigFile, writeFileAtomic } from "./config-file"

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "remote-session-config-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("readConfigFile", () => {
  test("reads a JSON object, skips a missing file, and logs a damaged one", () => {
    const dir = scratch()
    const good = join(dir, "good.json")
    const bad = join(dir, "bad.json")
    writeFileSync(good, `{"apiKey":"k"}`)
    writeFileSync(bad, "[1]")
    const logs: string[] = []

    expect({
      good: readConfigFile(good, (line) => logs.push(line)),
      missing: readConfigFile(join(dir, "missing.json"), (line) => logs.push(line)),
      bad: readConfigFile(bad, (line) => logs.push(line)),
      logs,
    }).toEqual({
      good: { apiKey: "k" },
      missing: undefined,
      bad: undefined,
      logs: [`ignoring ${bad}: config file must be a JSON object`],
    })
  })
})

describe("writeFileAtomic", () => {
  test("creates the parent and replaces a looser file with an owner-only one", () => {
    const path = join(scratch(), "nested", "cli.json")
    writeFileAtomic(path, "first\n")
    chmodSync(path, 0o644)

    writeFileAtomic(path, "second\n")

    expect({ content: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 }).toEqual({
      content: "second\n",
      mode: 0o600,
    })
  })
})
