import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WAKE_NOTE_TTL_MS, takeSessionWakeNote, wakeNotesDir, writeSessionWakeNote } from "./wake-note"

let dir: string
const previous = process.env.THREA_HARNESS_WAKE_NOTES_DIR

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "harness-wake-")), "wake")
  process.env.THREA_HARNESS_WAKE_NOTES_DIR = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.THREA_HARNESS_WAKE_NOTES_DIR
  else process.env.THREA_HARNESS_WAKE_NOTES_DIR = previous
})

const note = {
  runtimeSessionId: "ccs-abc",
  suspendedAt: "2026-09-09T10:00:00.000Z",
  wokeAt: "2026-09-09T10:20:00.000Z",
}

describe("session wake notes", () => {
  test("writes a note and hands it to the first reader only", () => {
    writeSessionWakeNote(note)

    const taken = takeSessionWakeNote("ccs-abc", Date.parse(note.wokeAt) + 5_000)

    expect({
      taken,
      second: takeSessionWakeNote("ccs-abc"),
      left: existsSync(wakeNotesDir()) ? "dir" : "gone",
    }).toEqual({
      taken: note,
      second: undefined,
      left: "dir",
    })
  })

  test("drops a note whose wake never happened", () => {
    writeSessionWakeNote(note)

    const stale = takeSessionWakeNote("ccs-abc", Date.parse(note.wokeAt) + WAKE_NOTE_TTL_MS + 1)

    expect({ stale, second: takeSessionWakeNote("ccs-abc") }).toEqual({ stale: undefined, second: undefined })
  })

  test("ignores a malformed note and an unsafe session id", () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "ccs-broken.json"), "{ not json")
    writeFileSync(join(dir, "ccs-partial.json"), JSON.stringify({ wokeAt: note.wokeAt }))

    expect({
      broken: takeSessionWakeNote("ccs-broken"),
      partial: takeSessionWakeNote("ccs-partial"),
      traversal: takeSessionWakeNote("../escape"),
      missing: takeSessionWakeNote("ccs-never-written"),
    }).toEqual({ broken: undefined, partial: undefined, traversal: undefined, missing: undefined })
  })
})
