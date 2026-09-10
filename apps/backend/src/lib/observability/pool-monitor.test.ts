import { describe, test, expect, spyOn, afterEach } from "bun:test"
import type { Pool } from "pg"
import { PoolMonitor } from "./pool-monitor"
import { logger } from "../logger"

function fakePool(totalCount: number, connected: number): Pool {
  return {
    totalCount,
    idleCount: totalCount,
    waitingCount: 0,
    options: { max: 30 },
    _clients: Array.from({ length: totalCount }, (_, i) => ({ _connected: i < connected })),
  } as unknown as Pool
}

describe("PoolMonitor unconnected-client detection", () => {
  const spies: { mockRestore: () => void }[] = []

  function captureErrors() {
    const messages: string[] = []
    const spy = spyOn(logger, "error").mockImplementation(((_data: unknown, msg?: string) => {
      messages.push(msg ?? "")
    }) as never)
    spies.push(spy)
    return messages
  }

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  test("should stay quiet while a client is still dialling", () => {
    const messages = captureErrors()
    const monitor = new PoolMonitor({ main: fakePool(5, 4) }, { disableLogging: true })

    monitor.start()
    monitor.stop()

    expect(messages).toEqual([])
  })

  test("should report a client still unconnected a sample later", () => {
    const messages = captureErrors()
    const monitor = new PoolMonitor({ main: fakePool(5, 4) }, { logIntervalMs: 1, disableLogging: true })

    monitor.start()
    monitor["logAllPoolStats"]()
    monitor.stop()

    expect(messages).toEqual([
      "Pool 'main' has held 1 unconnected client(s) for 2 samples; they are occupying pool slots without a connection",
    ])
  })

  test("should say nothing when every client is connected", () => {
    const messages = captureErrors()
    const monitor = new PoolMonitor({ main: fakePool(5, 5) }, { disableLogging: true })

    monitor.start()
    monitor["logAllPoolStats"]()
    monitor.stop()

    expect(messages).toEqual([])
  })
})
