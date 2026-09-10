import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeSessionWakeNote } from "@threahq/harness-client"
import { formatWakeBrief, takeWakeBrief } from "./wake-brief"

// Local wall-clock times, so the rendered "11:44" holds in any timezone.
const suspendedAt = new Date(2026, 8, 9, 11, 44)
const wokeAt = new Date(suspendedAt.getTime() + 16 * 60_000)
const note = {
  runtimeSessionId: "ccs-abc",
  suspendedAt: suspendedAt.toISOString(),
  wokeAt: wokeAt.toISOString(),
}

describe("formatWakeBrief", () => {
  test("tells the session what it lost, when, and that the resume is not the user's question", () => {
    const brief = formatWakeBrief(note)

    expect({
      when: brief?.notice.includes("suspended 11:44, asleep 16 min"),
      lost: brief?.notice.includes("background shell jobs"),
      noReply: brief?.notice.includes("needs no reply"),
      holdHint: brief?.notice.includes("threa-harnessd hold ccs-abc --minutes N"),
      step: brief?.step,
    }).toEqual({
      when: true,
      lost: true,
      noReply: true,
      holdHint: true,
      step: { stepType: "context_received", content: "Resumed from idle suspension (suspended 11:44, asleep 16 min)" },
    })
  })

  test("says nothing when the note's instants make no sense", () => {
    expect({
      unparsable: formatWakeBrief({ ...note, suspendedAt: "whenever" }),
      backwards: formatWakeBrief({ ...note, suspendedAt: note.wokeAt, wokeAt: note.suspendedAt }),
    }).toEqual({ unparsable: undefined, backwards: undefined })
  })
})

describe("takeWakeBrief", () => {
  let dir: string
  const previous = process.env.THREA_HARNESS_WAKE_NOTES_DIR

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "channel-wake-")), "wake")
    process.env.THREA_HARNESS_WAKE_NOTES_DIR = dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.THREA_HARNESS_WAKE_NOTES_DIR
    else process.env.THREA_HARNESS_WAKE_NOTES_DIR = previous
  })

  test("brings back harnessd's note once, and nothing for a session that was never suspended", () => {
    // Written against the real clock: a note older than its TTL is deliberately dropped.
    const woke = Date.now()
    writeSessionWakeNote({
      runtimeSessionId: "ccs-abc",
      suspendedAt: new Date(woke - 16 * 60_000).toISOString(),
      wokeAt: new Date(woke).toISOString(),
    })

    expect({
      first: takeWakeBrief("ccs-abc")?.step.content.includes("asleep 16 min"),
      second: takeWakeBrief("ccs-abc"),
      other: takeWakeBrief("ccs-other"),
    }).toEqual({ first: true, second: undefined, other: undefined })
  })
})
