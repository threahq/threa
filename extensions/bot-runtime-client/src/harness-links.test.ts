import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearHarnessLink, harnessLinksDir, readHarnessLinks, recordHarnessLink } from "./harness-links"

let dir: string
const previous = process.env.THREA_HARNESS_LINKS_DIR

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "harness-links-")), "links")
  process.env.THREA_HARNESS_LINKS_DIR = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.THREA_HARNESS_LINKS_DIR
  else process.env.THREA_HARNESS_LINKS_DIR = previous
})

const link = (overrides: Partial<Parameters<typeof recordHarnessLink>[0]> = {}) => ({
  runtimeKind: "claude-code-channel",
  runtimeSessionId: "ccs-abc",
  instanceId: "cc-abc",
  rootStreamId: "stream_root",
  worktree: "/repo/threa.feature",
  ...overrides,
})

describe("harness link registry", () => {
  test("records a link and reads it back, then clears it", () => {
    recordHarnessLink(link())

    const [recorded] = readHarnessLinks()
    expect(recorded).toMatchObject({
      runtimeKind: "claude-code-channel",
      runtimeSessionId: "ccs-abc",
      rootStreamId: "stream_root",
      worktree: "/repo/threa.feature",
      pid: process.pid,
    })

    clearHarnessLink("ccs-abc")
    expect(readHarnessLinks()).toEqual([])
  })

  test("one file per session, so concurrent runtimes never lose each other's records", () => {
    recordHarnessLink(link())
    recordHarnessLink(link({ runtimeSessionId: "pi-1", runtimeKind: "pi-local", worktree: "/repo/threa.other" }))

    expect(
      readHarnessLinks()
        .map((l) => l.runtimeSessionId)
        .sort()
    ).toEqual(["ccs-abc", "pi-1"])

    // Clearing one leaves the other intact — the failure a shared JSON document would have.
    clearHarnessLink("ccs-abc")
    expect(readHarnessLinks().map((l) => l.runtimeSessionId)).toEqual(["pi-1"])
  })

  test("re-recording the same session updates in place rather than duplicating", () => {
    recordHarnessLink(link())
    recordHarnessLink(link({ rootStreamId: "stream_replaced" }))

    const links = readHarnessLinks()
    expect(links).toHaveLength(1)
    expect(links[0]?.rootStreamId).toBe("stream_replaced")
  })

  test("a malformed or half-written file is skipped, never fatal", () => {
    recordHarnessLink(link())
    mkdirSync(harnessLinksDir(), { recursive: true })
    writeFileSync(join(harnessLinksDir(), "broken.json"), "{ not json")
    writeFileSync(join(harnessLinksDir(), "partial.json"), JSON.stringify({ runtimeSessionId: "x" }))

    expect(readHarnessLinks().map((l) => l.runtimeSessionId)).toEqual(["ccs-abc"])
  })

  test("a session id that would escape the directory is refused", () => {
    recordHarnessLink(link({ runtimeSessionId: "../escape" }))
    recordHarnessLink(link({ runtimeSessionId: "" }))

    expect(readHarnessLinks()).toEqual([])
  })

  test("reading before anything has been recorded is empty, not an error", () => {
    expect(readHarnessLinks()).toEqual([])
  })
})
