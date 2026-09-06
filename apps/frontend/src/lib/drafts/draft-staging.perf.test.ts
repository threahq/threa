import { afterEach, describe, expect, it } from "vitest"
import type { JSONContent } from "@threahq/types"
import { NO_CAPTURE, PerfCapture, armPerfCapture } from "@/lib/perf/capture"
import { stageDraftContent } from "./draft-staging"

const doc: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "the quick brown fox" }] }],
}

const key = "threa:draft-stage:ws_1:scope_1"

afterEach(() => {
  armPerfCapture(NO_CAPTURE)
  localStorage.clear()
})

describe("draft staging instrumentation", () => {
  it("records the serialized character count and the staging duration when armed", () => {
    const capture = new PerfCapture()
    armPerfCapture(capture)

    stageDraftContent("ws_1", "scope_1", doc)

    const samples = capture.snapshot()
    const staged = samples.find((s) => s.name === "draft.stagedChars")
    expect(staged?.value).toBe(localStorage.getItem(key)!.length)
    expect(samples.some((s) => s.name === "draft.staging")).toBe(true)
  })

  it("stages an identical payload whether armed or not", () => {
    stageDraftContent("ws_1", "scope_1", doc)
    const unarmed = localStorage.getItem(key)!
    localStorage.clear()

    armPerfCapture(new PerfCapture())
    stageDraftContent("ws_1", "scope_1", doc)
    const armed = localStorage.getItem(key)!

    // `clientUpdatedAt` is a wall clock; everything else must match byte for byte.
    const strip = (raw: string) => JSON.stringify(JSON.parse(raw).contentJson)
    expect(strip(armed)).toBe(strip(unarmed))
    expect(armed.length).toBe(unarmed.length)
  })
})
