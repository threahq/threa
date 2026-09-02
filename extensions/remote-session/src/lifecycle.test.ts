import { describe, expect, test } from "bun:test"
import { type LifecycleProcess, wireLifecycle } from "./lifecycle"

/** A fake `process` that records exits and lets a test emit signals / stdin events. */
function makeHost() {
  const listeners = new Map<string, ((arg?: unknown) => void)[]>()
  const stdinListeners = new Map<string, ((arg?: unknown) => void)[]>()
  const stderr: string[] = []
  const exits: number[] = []
  let resolveExited: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })
  const push = (map: Map<string, ((arg?: unknown) => void)[]>, event: string, listener: (arg?: unknown) => void) => {
    const arr = map.get(event) ?? []
    arr.push(listener)
    map.set(event, arr)
  }
  const host: LifecycleProcess = {
    ppid: 4242,
    on: (event, listener) => push(listeners, event, listener),
    stdin: { on: (event, listener) => push(stdinListeners, event, listener) },
    stderr: { write: (chunk) => stderr.push(chunk) },
    exit: ((code: number) => {
      exits.push(code)
      resolveExited()
    }) as (code: number) => never,
  }
  const emit = (event: string, arg?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(arg)
  }
  const emitStdin = (event: string, arg?: unknown) => {
    for (const listener of stdinListeners.get(event) ?? []) listener(arg)
  }
  return { host, emit, emitStdin, stderr, exits, exited }
}

describe("wireLifecycle", () => {
  test("SIGHUP runs graceful shutdown then exits 0", async () => {
    let shutdowns = 0
    const h = makeHost()
    wireLifecycle({ shutdown: async () => void shutdowns++ }, h.host)

    h.emit("SIGHUP")
    await h.exited

    expect(shutdowns).toBe(1)
    expect(h.exits).toEqual([0])
  })

  test("parent closing stdin (EOF) runs graceful shutdown then exits 0", async () => {
    let shutdowns = 0
    const h = makeHost()
    wireLifecycle({ shutdown: async () => void shutdowns++ }, h.host)

    h.emitStdin("end")
    await h.exited

    expect(shutdowns).toBe(1)
    expect(h.exits).toEqual([0])
  })

  test("should mark the host gone only when stdin closed and the parent is no longer running", async () => {
    for (const [trigger, parentAlive, expected] of [
      [(h: ReturnType<typeof makeHost>) => h.emitStdin("end"), false, { hostGone: true }],
      [(h: ReturnType<typeof makeHost>) => h.emitStdin("close"), false, { hostGone: true }],
      [(h: ReturnType<typeof makeHost>) => h.emitStdin("end"), true, { hostGone: false }],
      [(h: ReturnType<typeof makeHost>) => h.emit("SIGTERM"), false, {}],
      [(h: ReturnType<typeof makeHost>) => h.emit("SIGHUP"), false, {}],
    ] as const) {
      const received: unknown[] = []
      const h = makeHost()
      wireLifecycle({ shutdown: async (options) => void received.push(options) }, h.host, {
        parentAlive: () => parentAlive,
        parentProbeDelayMs: 0,
      })
      trigger(h)
      await h.exited
      expect(received).toEqual([expected])
    }
  })

  test("should probe the pid captured at wiring, after the delay, not at the moment stdin closes", async () => {
    let alive = true
    const received: unknown[] = []
    const probed: number[] = []
    const h = makeHost()
    wireLifecycle({ shutdown: async (options) => void received.push(options) }, h.host, {
      parentAlive: (pid) => {
        probed.push(pid)
        return alive
      },
      parentProbeDelayMs: 20,
    })
    // A reparented child would now read a different, live ppid; the wiring-time pid is what gets probed.
    h.host.ppid = 1
    h.emitStdin("end")
    alive = false
    await h.exited
    expect({ received, probed }).toEqual({ received: [{ hostGone: true }], probed: [4242] })
  })

  test("an unhandled rejection is logged and exits non-zero after cleanup", async () => {
    let shutdowns = 0
    const h = makeHost()
    wireLifecycle({ shutdown: async () => void shutdowns++ }, h.host)

    h.emit("unhandledRejection", new Error("boom"))
    await h.exited

    expect(shutdowns).toBe(1)
    expect(h.exits).toEqual([1])
    expect(h.stderr.join("")).toContain("unhandledRejection")
    expect(h.stderr.join("")).toContain("boom")
  })

  test("only the first death path acts — repeated signals don't double-shutdown", async () => {
    let shutdowns = 0
    const h = makeHost()
    wireLifecycle({ shutdown: async () => void shutdowns++ }, h.host)

    h.emit("SIGTERM")
    h.emitStdin("close")
    h.emit("SIGHUP")
    await h.exited
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(shutdowns).toBe(1)
    expect(h.exits).toEqual([0])
  })

  test("exits even if shutdown hangs past the guard window", async () => {
    const h = makeHost()
    // shutdown that never resolves — the bounded guard must still force the exit.
    wireLifecycle({ shutdown: () => new Promise<void>(() => {}) }, h.host, { exitGuardMs: 20 })

    h.emit("SIGTERM")
    await h.exited

    expect(h.exits).toEqual([0])
  })
})
