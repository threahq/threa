import { describe, expect, test } from "bun:test"
import { parseDuration, parseSince, pickSections } from "./cli"

describe("flag parsing", () => {
  test("parseDuration reads ms/s/m/h, falls back when absent, rejects anything else", () => {
    expect([
      parseDuration("5ms", 0),
      parseDuration("30s", 0),
      parseDuration("5m", 0),
      parseDuration("2h", 0),
      parseDuration(undefined, 7),
    ]).toEqual([5, 30_000, 300_000, 7_200_000, 7])
    expect(() => parseDuration("soon", 0)).toThrow()
  })
  test("--since accepts relative durations and ISO timestamps", () => {
    const now = new Date("2026-08-21T18:00:00Z")
    expect(parseSince("45m", now)).toBe("2026-08-21T17:15:00.000Z")
    expect(parseSince("2026-08-21T17:39:43Z", now)).toBe("2026-08-21T17:39:43.000Z")
    expect(parseSince(undefined, now)).toBeUndefined()
    expect(() => parseSince("yesterday", now)).toThrow()
  })
  test("--only and --skip select sections and reject unknown ones", () => {
    expect([...pickSections(undefined, undefined)]).toEqual(["revision", "liveness", "pipelines", "logs", "resources"])
    expect([...pickSections("revision,logs", undefined)]).toEqual(["revision", "logs"])
    expect([...pickSections(undefined, "resources,logs")]).toEqual(["revision", "liveness", "pipelines"])
    expect(() => pickSections("nope", undefined)).toThrow("unknown section: nope")
  })
})
