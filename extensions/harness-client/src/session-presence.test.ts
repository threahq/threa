import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSessionPresence, readSessionPresence, writeSessionPresence } from "./session-presence"

let dir: string
const previous = process.env.THREA_HARNESS_PRESENCE_DIR

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "harness-presence-")), "presence")
  process.env.THREA_HARNESS_PRESENCE_DIR = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.THREA_HARNESS_PRESENCE_DIR
  else process.env.THREA_HARNESS_PRESENCE_DIR = previous
})

const snapshot = {
  runtimeKind: "claude-code-channel",
  instanceId: "inst-1",
  runtimeSessionId: "ccs-abc",
  displayName: "threa.latex-support",
  capabilities: {
    runtimeSessionId: "ccs-abc",
    supportsSessionControlCommands: true,
    sessionControlCommands: ["model", "compact"],
  },
  manifest: { output: {}, input: { updates: "live" } },
}

describe("session presence snapshots", () => {
  test("round-trips what the session published", () => {
    writeSessionPresence(snapshot)

    const read = readSessionPresence("ccs-abc")

    expect(read).toEqual({ ...snapshot, updatedAt: read?.updatedAt ?? "" })
    expect(Date.parse(read?.updatedAt ?? "")).toBeGreaterThan(0)
  })

  test("drops the snapshot when the session goes offline", () => {
    writeSessionPresence(snapshot)

    clearSessionPresence("ccs-abc")

    expect(readSessionPresence("ccs-abc")).toBeUndefined()
  })

  test("answers undefined rather than half a snapshot", () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "ccs-broken.json"), "{ not json")
    writeFileSync(join(dir, "ccs-partial.json"), JSON.stringify({ runtimeKind: "claude-code-channel" }))
    writeFileSync(
      join(dir, "ccs-listy.json"),
      JSON.stringify({ runtimeKind: "claude-code-channel", instanceId: "i", capabilities: [] })
    )

    expect({
      broken: readSessionPresence("ccs-broken"),
      partial: readSessionPresence("ccs-partial"),
      listy: readSessionPresence("ccs-listy"),
      missing: readSessionPresence("ccs-never-written"),
      traversal: readSessionPresence("../escape"),
    }).toEqual({
      broken: undefined,
      partial: undefined,
      listy: undefined,
      missing: undefined,
      traversal: undefined,
    })
  })

  test("refuses to write under an unsafe session id", () => {
    writeSessionPresence({ ...snapshot, runtimeSessionId: "../escape" })

    expect(readSessionPresence("../escape")).toBeUndefined()
  })
})
