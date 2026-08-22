import { describe, expect, test } from "bun:test"
import { exitCodeFor, makeWindow, worst } from "./types"

describe("makeWindow", () => {
  const now = new Date("2026-08-21T18:00:00Z")
  test("a recent deploy is floored to the minimum window and says so", () => {
    const w = makeWindow(new Date("2026-08-21T17:55:00Z"), now, 30 * 60_000, "since backend deploy")
    expect(w).toEqual({
      since: "2026-08-21T17:30:00.000Z",
      priorStart: "2026-08-21T17:00:00.000Z",
      now: now.toISOString(),
      label: "since backend deploy 17:55Z (30m window, floored to 30m)",
    })
  })
  test("an older deploy keeps its real span and an equal prior window", () => {
    const w = makeWindow(new Date("2026-08-21T16:00:00Z"), now, 30 * 60_000, "since backend deploy")
    expect(w.since).toBe("2026-08-21T16:00:00.000Z")
    expect(w.priorStart).toBe("2026-08-21T14:00:00.000Z")
    expect(w.label).toBe("since backend deploy 16:00Z (120m window)")
  })
})

test("worst ranks fail > warn > pending > ok and maps to exit codes", () => {
  expect(worst(["ok", "pending", "warn"])).toBe("warn")
  expect(worst(["ok", "skipped"])).toBe("ok")
  expect(worst(["warn", "fail", "pending"])).toBe("fail")
  expect([exitCodeFor("ok"), exitCodeFor("pending"), exitCodeFor("warn"), exitCodeFor("fail")]).toEqual([0, 1, 1, 2])
})
