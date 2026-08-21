import { describe, expect, test } from "bun:test"
import { diffFindings } from "./render"

describe("diffFindings", () => {
  test("reports new and changed findings as added, vanished ones as resolved", () => {
    const prev = [
      { level: "warn" as const, id: "a", message: "a v1" },
      { level: "warn" as const, id: "b", message: "b" },
    ]
    const next = [
      { level: "warn" as const, id: "a", message: "a v2" },
      { level: "fail" as const, id: "c", message: "c" },
    ]
    const d = diffFindings(prev, next)
    expect(d.added.map((f) => f.id)).toEqual(["a", "c"])
    expect(d.resolved.map((f) => f.id)).toEqual(["b"])
  })
})
