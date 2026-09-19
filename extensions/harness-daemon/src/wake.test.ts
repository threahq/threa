import { describe, expect, test } from "bun:test"
import { formatWakeFailureNotice, wakeFailureDetail } from "./wake"

describe("wakeFailureDetail", () => {
  test("a started or already-running session has someone to answer the turn", () => {
    expect(wakeFailureDetail({ status: "started" })).toBeUndefined()
    expect(wakeFailureDetail({ status: "already running" })).toBeUndefined()
  })

  test("an unreachable Threa is left to the backoff retry", () => {
    expect(wakeFailureDetail({ status: "skipped unavailable", detail: "503" })).toBeUndefined()
  })

  test("every other outcome leaves the invocation pending and is reported", () => {
    expect(wakeFailureDetail({ status: "failed", detail: "launch failed: bad MCP config" })).toBe(
      "failed: launch failed: bad MCP config"
    )
    expect(wakeFailureDetail({ status: "blocked" })).toBe("blocked")
    expect(wakeFailureDetail({ status: "skipped missing cwd", detail: "/repo/gone" })).toBe(
      "skipped missing cwd: /repo/gone"
    )
  })

  test("a row the sweep never decided on is itself the silence", () => {
    expect(wakeFailureDetail(undefined)).toBe("the row was not evaluated for revival")
  })
})

describe("formatWakeFailureNotice", () => {
  test("names the failure and where to look", () => {
    const notice = formatWakeFailureNotice("failed: launch failed: bad MCP config")
    expect(notice).toContain("failed: launch failed: bad MCP config")
    expect(notice).toContain("watch.log")
  })
})
