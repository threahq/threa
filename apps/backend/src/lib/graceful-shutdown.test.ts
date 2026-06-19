import { describe, expect, mock, test } from "bun:test"
import { runWithShutdownWatchdog } from "./graceful-shutdown"

function makeFakeTimers() {
  let fire: (() => void) | null = null
  let cleared = false
  return {
    trigger: () => fire?.(),
    wasCleared: () => cleared,
    timers: {
      setTimeout: (callback: () => void) => {
        fire = callback
        return { unref: () => {} }
      },
      clearTimeout: () => {
        cleared = true
      },
    },
  }
}

describe("runWithShutdownWatchdog", () => {
  test("completes via onComplete and clears the timer when shutdown settles in time", async () => {
    const fake = makeFakeTimers()
    const onComplete = mock(() => {})
    const onTimeout = mock(() => {})

    await runWithShutdownWatchdog({
      shutdown: async () => {},
      timeoutMs: 100,
      onComplete,
      onTimeout,
      timers: fake.timers,
    })

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(fake.wasCleared()).toBe(true)
  })

  test("fires onTimeout when shutdown overruns the deadline, and ignores a late completion", async () => {
    const fake = makeFakeTimers()
    const onComplete = mock(() => {})
    const onTimeout = mock(() => {})

    let resolveShutdown: () => void = () => {}
    const shutdownPromise = new Promise<void>((resolve) => {
      resolveShutdown = resolve
    })

    const watchdog = runWithShutdownWatchdog({
      shutdown: () => shutdownPromise,
      timeoutMs: 100,
      onComplete,
      onTimeout,
      timers: fake.timers,
    })

    fake.trigger()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()

    // A shutdown that finally settles after the deadline must not double-fire.
    resolveShutdown()
    await watchdog
    expect(onComplete).not.toHaveBeenCalled()
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})
