import { afterEach, describe, expect, it, mock } from "bun:test"
import { createCallSweeper } from "./sweeper"
import type { CallService } from "./service"

function makeServiceSpy() {
  return {
    expireStaleRings: mock(async () => ({ expired: 0 })),
    reapLapsedEndpoints: mock(async () => ({ endpoints: 0, participants: 0, calls: 0 })),
    endGraceExpiredCalls: mock(async () => ({ ended: 0 })),
  }
}

describe("createCallSweeper", () => {
  afterEach(() => mock.restore())

  it("runs all three sweeps once on start and stops cleanly", async () => {
    const service = makeServiceSpy()
    const sweeper = createCallSweeper(service as unknown as CallService, { intervalMs: 60_000 })

    sweeper.start()
    await Promise.resolve()
    await Promise.resolve()
    sweeper.stop()

    expect(service.expireStaleRings).toHaveBeenCalledTimes(1)
    expect(service.reapLapsedEndpoints).toHaveBeenCalledTimes(1)
    expect(service.endGraceExpiredCalls).toHaveBeenCalledTimes(1)
  })

  it("reaps endpoints and ends graced calls BEFORE expiring rings (S6 — no false missed calls)", async () => {
    const order: string[] = []
    const service = {
      reapLapsedEndpoints: mock(async () => {
        order.push("reap")
        return { endpoints: 0, participants: 0, calls: 0 }
      }),
      endGraceExpiredCalls: mock(async () => {
        order.push("grace-end")
        return { ended: 0 }
      }),
      expireStaleRings: mock(async () => {
        order.push("expire-rings")
        return { expired: 0 }
      }),
    }
    const sweeper = createCallSweeper(service as unknown as CallService, { intervalMs: 60_000 })

    sweeper.start()
    await Promise.resolve()
    await Promise.resolve()
    sweeper.stop()

    // An abandoned caller's lapsed endpoint cancels its ring on reap/grace-end, so the
    // ring never expires into a missed call one statement before the reap would.
    expect(order).toEqual(["reap", "grace-end", "expire-rings"])
  })
})
