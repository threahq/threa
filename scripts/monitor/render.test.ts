import { describe, expect, test } from "bun:test"
import { diffFindings } from "./render"

describe("diffFindings", () => {
  test("keys on id: new ids are added, a level change is changed, a changed message alone is neither, vanished ids are resolved", () => {
    const prev = [
      { level: "warn" as const, id: "a", message: "a v1" },
      { level: "warn" as const, id: "b", message: "b" },
    ]
    const next = [
      { level: "fail" as const, id: "a", message: "a v2" },
      { level: "fail" as const, id: "c", message: "c" },
    ]
    const diff = diffFindings(prev, next)
    expect(diff).toEqual({
      added: [{ level: "fail", id: "c", message: "c" }],
      changed: [{ level: "fail", id: "a", message: "a v2" }],
      resolved: [{ level: "warn", id: "b", message: "b" }],
    })
    expect(diffFindings(next, [{ level: "fail", id: "a", message: "a v3 (lag 42)" }, next[1]])).toEqual({
      added: [],
      changed: [],
      resolved: [],
    })
  })
})
