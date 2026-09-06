import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test"
import { Ticker } from "@threahq/backend-common"

describe("Ticker", () => {
  let ticker: Ticker

  afterEach(() => {
    if (ticker?.isRunning()) {
      ticker.stop()
    }
  })

  describe("basic functionality", () => {
    it("should execute callback on interval", async () => {
      const callback = vi.fn(async () => {
        // Noop
      })

      ticker = new Ticker({
        name: "test",
        intervalMs: 50,
        maxConcurrency: 1,
      })

      ticker.start(callback)

      // Wait for at least 2 ticks (with buffer for CI timing variance)
      await new Promise((resolve) => setTimeout(resolve, 130))

      ticker.stop()

      // Should have at least 2 calls (50ms and 100ms ticks)
      // Using >= to handle CI timing variance
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it("should not execute if already at max concurrency", async () => {
      let resolveCallback: (() => void) | null = null
      const callback = vi.fn(async () => {
        // Block until resolved
        await new Promise<void>((resolve) => {
          resolveCallback = resolve
        })
      })

      ticker = new Ticker({
        name: "test",
        intervalMs: 50,
        maxConcurrency: 1,
      })

      ticker.start(callback)

      // Wait for first tick to start
      await new Promise((resolve) => setTimeout(resolve, 60))

      // Callback should be called once and be blocking
      expect(callback).toHaveBeenCalledTimes(1)
      expect(ticker.getInFlightCount()).toBe(1)

      // Wait for potential second tick (should be skipped due to max concurrency)
      await new Promise((resolve) => setTimeout(resolve, 60))

      // Should still be 1 call (second tick skipped)
      expect(callback).toHaveBeenCalledTimes(1)

      // Unblock callback
      resolveCallback!()

      // Wait for callback to complete and next tick
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should have second call now
      expect(callback).toHaveBeenCalledTimes(2)

      ticker.stop()
    })

    it("should allow multiple concurrent callbacks up to maxConcurrency", async () => {
      const activeCallbacks: number[] = []
      let maxConcurrent = 0

      const callback = vi.fn(async (callNum: number) => {
        activeCallbacks.push(callNum)
        maxConcurrent = Math.max(maxConcurrent, activeCallbacks.length)

        // Block for a bit
        await new Promise((resolve) => setTimeout(resolve, 100))

        activeCallbacks.splice(activeCallbacks.indexOf(callNum), 1)
      })

      let callNum = 0
      ticker = new Ticker({
        name: "test",
        intervalMs: 20,
        maxConcurrency: 3,
      })

      ticker.start(async () => {
        await callback(callNum++)
      })

      // Wait for multiple ticks
      await new Promise((resolve) => setTimeout(resolve, 200))

      ticker.stop()
      await ticker.drain()

      // Should have allowed up to 3 concurrent callbacks
      expect(maxConcurrent).toBe(3)
    })
  })

  describe("error handling", () => {
    it("should continue ticking after callback error", async () => {
      let callCount = 0
      const callback = vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error("First call fails")
        }
      })

      ticker = new Ticker({
        name: "test",
        intervalMs: 50,
        maxConcurrency: 1,
      })

      ticker.start(callback)

      // Wait for at least 2 ticks (with buffer for CI timing variance)
      await new Promise((resolve) => setTimeout(resolve, 130))

      ticker.stop()

      // Should have called callback despite first error
      // Using >= to handle CI timing variance
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("drain", () => {
    it("should wait for all in-flight callbacks to complete", async () => {
      let completed = 0

      const callback = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        completed++
      })

      ticker = new Ticker({
        name: "test",
        intervalMs: 20,
        maxConcurrency: 3,
      })

      ticker.start(callback)

      // Wait for some ticks to start
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Stop ticker (no new ticks)
      ticker.stop()

      const inFlight = ticker.getInFlightCount()
      expect(inFlight).toBeGreaterThan(0)

      // Drain should wait for all in-flight to complete
      await ticker.drain()

      expect(ticker.getInFlightCount()).toBe(0)
      expect(completed).toBe(inFlight)
    })

    it("should resolve immediately if no in-flight callbacks", async () => {
      ticker = new Ticker({
        name: "test",
        intervalMs: 100,
        maxConcurrency: 1,
      })

      // Don't start ticker - no in-flight callbacks
      await ticker.drain()

      expect(ticker.getInFlightCount()).toBe(0)
    })
  })

  describe("start/stop", () => {
    it("should throw if started twice", () => {
      ticker = new Ticker({
        name: "test",
        intervalMs: 100,
        maxConcurrency: 1,
      })

      ticker.start(async () => {})

      expect(() => ticker.start(async () => {})).toThrow("already started")

      ticker.stop()
    })

    it("should stop ticking after stop()", async () => {
      const callback = vi.fn(async () => {})

      ticker = new Ticker({
        name: "test",
        intervalMs: 50,
        maxConcurrency: 1,
      })

      ticker.start(callback)

      // Wait for a tick
      await new Promise((resolve) => setTimeout(resolve, 60))

      const callsBeforeStop = callback.mock.calls.length

      ticker.stop()

      // Wait for what would be another tick
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should not have additional calls
      expect(callback).toHaveBeenCalledTimes(callsBeforeStop)
    })
  })

  describe("isRunning", () => {
    it("should return true when running", () => {
      ticker = new Ticker({
        name: "test",
        intervalMs: 100,
        maxConcurrency: 1,
      })

      expect(ticker.isRunning()).toBe(false)

      ticker.start(async () => {})

      expect(ticker.isRunning()).toBe(true)

      ticker.stop()

      expect(ticker.isRunning()).toBe(false)
    })
  })
})
