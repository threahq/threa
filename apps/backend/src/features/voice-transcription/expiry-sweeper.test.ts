import { describe, expect, it, mock } from "bun:test"
import { createVoiceSessionSweeper } from "./expiry-sweeper"
import type { VoiceTranscriptionService } from "./service"

function fakeService(expireStaleSessions: () => Promise<number>) {
  return { expireStaleSessions: mock(expireStaleSessions) } as unknown as VoiceTranscriptionService
}

describe("createVoiceSessionSweeper", () => {
  it("sweeps once immediately on start to catch sessions stranded by a restart", async () => {
    const service = fakeService(async () => 2)
    const sweeper = createVoiceSessionSweeper(service, { intervalMs: 60_000 })

    sweeper.start()
    // start() fires the sweep without awaiting; let the microtask settle.
    await Promise.resolve()
    sweeper.stop()

    expect(service.expireStaleSessions).toHaveBeenCalledTimes(1)
  })

  it("swallows a failing sweep so the interval keeps running", async () => {
    const service = fakeService(async () => {
      throw new Error("db down")
    })
    const sweeper = createVoiceSessionSweeper(service)

    expect(() => sweeper.start()).not.toThrow()
    await Promise.resolve()
    sweeper.stop()
  })

  it("is idempotent: a second start does not add a second timer", async () => {
    const service = fakeService(async () => 0)
    const sweeper = createVoiceSessionSweeper(service)

    sweeper.start()
    sweeper.start()
    await Promise.resolve()
    sweeper.stop()

    // Only the first start's immediate sweep ran; the second was a no-op.
    expect(service.expireStaleSessions).toHaveBeenCalledTimes(1)
  })
})
