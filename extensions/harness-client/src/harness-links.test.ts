import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearHarnessLink,
  harnessLinksDir,
  markHarnessLinkWoundDown,
  readHarnessLinks,
  recordHarnessLink,
} from "./harness-links"

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

  test("a new session in the same worktree supersedes the previous record", () => {
    // Worktree paths are stable per feature name and get reused. A record left
    // by a crashed runtime would otherwise point a reaper at that directory
    // using the OLD session's root stream, while a live session occupies it.
    recordHarnessLink(link({ runtimeSessionId: "ccs-old", rootStreamId: "stream_old" }))
    recordHarnessLink(link({ runtimeSessionId: "ccs-new", rootStreamId: "stream_new" }))

    expect(readHarnessLinks()).toMatchObject([{ runtimeSessionId: "ccs-new", rootStreamId: "stream_new" }])
  })

  test("a record for a different worktree is left alone", () => {
    recordHarnessLink(link({ runtimeSessionId: "ccs-a" }))
    recordHarnessLink(link({ runtimeSessionId: "ccs-b", worktree: "/repo/threa.other" }))

    expect(
      readHarnessLinks()
        .map((l) => l.runtimeSessionId)
        .sort()
    ).toEqual(["ccs-a", "ccs-b"])
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

  test("marking a wind-down keeps the record findable and preserves its fields", () => {
    // Clearing it here instead would strand the worktree: harnessd does the
    // pushing and the removal, and the record is how it finds the worktree.
    recordHarnessLink(link())

    markHarnessLinkWoundDown("ccs-abc")

    const [marked] = readHarnessLinks()
    expect(marked).toMatchObject({
      runtimeSessionId: "ccs-abc",
      rootStreamId: "stream_root",
      worktree: "/repo/threa.feature",
    })
    expect(typeof marked?.windDownRequestedAt).toBe("string")
  })

  test("a relink after an unarchive clears the mark", () => {
    // The mark must not survive a revival: the worktree is live again, and a
    // stale mark tells the reaper to skip every margin protecting it.
    recordHarnessLink(link())
    markHarnessLinkWoundDown("ccs-abc")

    recordHarnessLink(link())

    expect(readHarnessLinks()[0]?.windDownRequestedAt).toBeUndefined()
  })

  test("marking a session that was never recorded writes no file at all", () => {
    // A mark is a hand-off of a worktree a live runtime claimed. Minting a
    // record here would point the reaper at a directory nobody vouched for.
    // Another session's record first, so the links dir exists and a stray
    // write would actually land.
    recordHarnessLink(link())

    markHarnessLinkWoundDown("ccs-never-linked")

    expect(existsSync(join(harnessLinksDir(), "ccs-never-linked.json"))).toBe(false)
  })
})

test("an unreadable links directory throws rather than reading as no links", () => {
  // `doctor` prints this count. "0 drift" from a scan that never ran is the
  // unfalsifiable clean result the whole identity effort exists to remove.
  const dir = mkdtempSync(join(tmpdir(), "harness-links-locked-"))
  process.env.THREA_HARNESS_LINKS_DIR = dir
  chmodSync(dir, 0o000)
  try {
    expect(() => readHarnessLinks()).toThrow(/could not read the harness link directory/)
  } finally {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})
