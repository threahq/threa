import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  CALL_LIFECYCLE_LOG_MAX,
  clearCallLifecycleLog,
  getCallLifecycleEvents,
  recordCallLifecycleEvent,
  subscribeCallLifecycle,
} from "./lifecycle-log"

describe("call lifecycle log", () => {
  beforeEach(() => {
    clearCallLifecycleLog()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"))
  })
  afterEach(() => {
    vi.useRealTimers()
    clearCallLifecycleLog()
  })

  it("keeps the newest MAX entries and drops the oldest", () => {
    for (let i = 0; i < CALL_LIFECYCLE_LOG_MAX + 5; i++) {
      recordCallLifecycleEvent({ kind: "freeze", detail: String(i) })
    }

    const events = getCallLifecycleEvents()
    // The surviving window is entries 5..MAX+4 — the first five fell off.
    expect(events.map((e) => e.detail)).toEqual(Array.from({ length: CALL_LIFECYCLE_LOG_MAX }, (_, i) => String(i + 5)))
  })

  it("stamps `at` and carries kind + detail", () => {
    recordCallLifecycleEvent({ kind: "lease_renew_failed", detail: "CALL_LEASE_SUPERSEDED" })

    expect(getCallLifecycleEvents()).toEqual([
      { at: Date.parse("2026-07-01T10:00:00.000Z"), kind: "lease_renew_failed", detail: "CALL_LEASE_SUPERSEDED" },
    ])
  })

  it("notifies subscribers on record and stops after unsubscribe", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeCallLifecycle(listener)

    recordCallLifecycleEvent({ kind: "visible" })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    recordCallLifecycleEvent({ kind: "hidden" })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("clearCallLifecycleLog empties the ring", () => {
    recordCallLifecycleEvent({ kind: "teardown" })
    clearCallLifecycleLog()
    expect(getCallLifecycleEvents()).toEqual([])
  })
})
