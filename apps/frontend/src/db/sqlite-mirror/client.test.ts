import { afterEach, describe, expect, it, vi } from "vitest"
import { withProgressDeadline } from "./client"
import type { MirrorTransport } from "./protocol"

const owned: Array<() => unknown> = []
afterEach(() => {
  for (const cleanup of owned.splice(0)) cleanup()
})

describe("withProgressDeadline", () => {
  const silentTransport = { heardAt: () => 0 } as MirrorTransport
  const replyAfter = (ms: number) => new Promise<string>((resolve) => setTimeout(() => resolve("reply"), ms))

  it("rejects once the worker was silent for the deadline", async () => {
    await expect(withProgressDeadline(silentTransport, replyAfter(200), 40, "read")).rejects.toThrow(
      /reported nothing for 40 ms/
    )
  })

  it("does not count time the page was frozen, during which no reply could arrive", async () => {
    const now = performance.now.bind(performance)
    let frozenMs = 0
    const spy = vi.spyOn(performance, "now").mockImplementation(() => now() + frozenMs)
    owned.push(() => spy.mockRestore())
    const reply = withProgressDeadline(silentTransport, replyAfter(60), 40, "read")
    frozenMs = 5_000
    await expect(reply).resolves.toBe("reply")
  })
})
