import { afterEach, describe, expect, it, mock } from "bun:test"
import { createCallSweeper } from "./sweeper"
import type { CallService } from "./service"

function makeServiceSpy() {
  let markSwept!: () => void
  const swept = new Promise<void>((resolve) => {
    markSwept = resolve
  })
  return {
    service: {
      expireStaleRings: mock(async () => ({ expired: 0 })),
      reapLapsedEndpoints: mock(async () => ({ endpoints: 0, participants: 0, calls: 0 })),
      endGraceExpiredCalls: mock(async () => ({ ended: 0 })),
      sweepTransportTransfers: mock(async () => markSwept()),
    },
    swept,
  }
}

describe("createCallSweeper", () => {
  afterEach(() => mock.restore())

  it("runs all three sweeps once on start and stops cleanly", async () => {
    const { service, swept } = makeServiceSpy()
    const sweeper = createCallSweeper(service as unknown as CallService, { intervalMs: 60_000 })

    sweeper.start()
    await swept
    sweeper.stop()

    expect({
      expireStaleRings: service.expireStaleRings.mock.calls.length,
      reapLapsedEndpoints: service.reapLapsedEndpoints.mock.calls.length,
      endGraceExpiredCalls: service.endGraceExpiredCalls.mock.calls.length,
      sweepTransportTransfers: service.sweepTransportTransfers.mock.calls.length,
    }).toEqual({
      expireStaleRings: 1,
      reapLapsedEndpoints: 1,
      endGraceExpiredCalls: 1,
      sweepTransportTransfers: 1,
    })
  })

  it("reaps endpoints and ends graced calls BEFORE expiring rings (S6 — no false missed calls)", async () => {
    const order: string[] = []
    let markSwept!: () => void
    const swept = new Promise<void>((resolve) => {
      markSwept = resolve
    })
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
      sweepTransportTransfers: mock(async () => {
        order.push("transfer")
        markSwept()
      }),
    }
    const sweeper = createCallSweeper(service as unknown as CallService, { intervalMs: 60_000 })

    sweeper.start()
    await swept
    sweeper.stop()

    // An abandoned caller's lapsed endpoint cancels its ring on reap/grace-end, so the
    // ring never expires into a missed call one statement before the reap would.
    expect(order).toEqual(["reap", "grace-end", "expire-rings", "transfer"])
  })
})
