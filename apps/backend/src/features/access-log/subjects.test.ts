import { describe, expect, it } from "bun:test"
import { capSubjects, SUBJECTS_CAP } from "./subjects"

describe("capSubjects", () => {
  it("passes id-shaped refs through untouched", () => {
    const refs = [
      { type: "stream", id: "stream_01ABC", fromSeq: 1, toSeq: 9 },
      { type: "workspace", id: "ws_01ABC" },
      { type: "bot_invocation", id: "binv_01ABC" },
    ]
    expect(capSubjects(refs)).toEqual(refs)
  })

  it("redacts non-id-shaped ids and invalid types (no-content rule)", () => {
    const out = capSubjects([
      { type: "attachment", id: "kris's diary entry about pierre" },
      { type: "Weird Type!", id: "attach_ok" },
      { type: "message", id: "x".repeat(300) },
    ])
    expect(out).toEqual([
      { type: "attachment", id: "#redacted" },
      { type: "invalid", id: "attach_ok" },
      { type: "message", id: "#redacted" },
    ])
  })

  it("caps at SUBJECTS_CAP with an overflow tail", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ type: "message", id: `msg_${i}` }))
    const out = capSubjects(many)
    expect(out).toHaveLength(SUBJECTS_CAP)
    expect(out[SUBJECTS_CAP - 1]).toEqual({ type: "overflow", count: 51 })
  })
})
