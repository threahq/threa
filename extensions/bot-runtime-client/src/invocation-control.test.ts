import { describe, expect, it, mock } from "bun:test"
import {
  InvocationControlManager,
  parseCancellationReason,
  type ControlSyncResult,
  type InvocationControlSyncRequest,
  type InvocationControlScheduler,
  type InvocationControlState,
  type ObserveClaimParams,
} from "./invocation-control"

const expires = (ms = 60_000) => new Date(Date.now() + ms).toISOString()
const control = (state: InvocationControlState): ControlSyncResult => ({ kind: "control", state })
const active = (revision: number, promptMarkdown?: string, claimExpiresAt = expires()): ControlSyncResult =>
  control({
    invocationId: "binv_1",
    status: "active",
    claimExpiresAt,
    sourceRevision: revision,
    ...(promptMarkdown === undefined
      ? {}
      : {
          update: {
            delivery: "plaintext",
            sourceRevision: revision,
            promptMarkdown,
            mentionedActorSlugs: [],
          },
        }),
  })

function params(
  onInputUpdated: ObserveClaimParams["callbacks"]["onInputUpdated"] = () => "applied",
  onCancelled: ObserveClaimParams["callbacks"]["onCancelled"] = () => {}
): ObserveClaimParams {
  return {
    invocationId: "binv_1",
    sourceMessageId: "msg_1",
    claimToken: "claim_secret",
    sourceRevision: 2,
    claimTtlSeconds: 60,
    callbacks: { onInputUpdated, onCancelled },
  }
}

function setup(
  implementation: (request: InvocationControlSyncRequest) => Promise<ControlSyncResult>,
  options: {
    retryDelayMs?: number
    minRenewDelayMs?: number
    now?: () => number
    scheduler?: InvocationControlScheduler
  } = {}
) {
  const requests: InvocationControlSyncRequest[] = []
  const sync = mock(async (request: InvocationControlSyncRequest) => {
    requests.push(request)
    return implementation(request)
  })
  const logs: string[] = []
  const manager = new InvocationControlManager(
    { sync, socketReady: () => true, log: (message) => logs.push(message) },
    { retryDelayMs: 5, minRenewDelayMs: 2, ...options }
  )
  return { manager, requests, sync, logs }
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(1)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeScheduler implements InvocationControlScheduler {
  private nowMs = 0
  private nextId = 1
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()
  private fired = 0

  get pendingCount(): number {
    return this.tasks.size
  }

  get firedCount(): number {
    return this.fired
  }

  get pendingDelays(): number[] {
    return [...this.tasks.values()].map((task) => task.at - this.nowMs)
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.tasks.set(id, { at: this.nowMs + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  advanceBy(ms: number): void {
    const target = this.nowMs + ms
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (!next) break
      this.nowMs = next[1].at
      this.tasks.delete(next[0])
      this.fired++
      next[1].callback()
    }
    this.nowMs = target
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("InvocationControlManager", () => {
  it("synchronizes immediately on observe and delivers authoritative plaintext", async () => {
    const updates: unknown[] = []
    const { manager, sync } = setup(async () => active(3, "authoritative"))
    const handle = manager.observe(params((update) => (updates.push(update), "applied")))

    await waitFor(() => handle.currentRevision === 3)

    expect(updates).toEqual([
      expect.objectContaining({ sourceRevision: 3, promptMarkdown: "authoritative", attachmentRefs: [] }),
    ])
    expect(sync).toHaveBeenCalledTimes(1)
    handle.unregister()
  })

  it("holds availability until a behind revision-2 response drains authoritative revision 4", async () => {
    const first = deferred<ControlSyncResult>()
    const second = deferred<ControlSyncResult>()
    const order: string[] = []
    let calls = 0
    const { manager, sync } = setup(async () => (++calls === 1 ? first.promise : second.promise))
    const handle = manager.observe(params((update) => (order.push(`update:${update.sourceRevision}`), "applied")))
    await waitFor(() => sync.mock.calls.length === 1)

    manager.hint({ invocationId: "binv_1", sourceRevision: 4 }, false)
    const availability = manager.enqueueAdapter(() => order.push("available"))
    first.resolve(active(2))
    await waitFor(() => sync.mock.calls.length === 2)

    expect(order).toEqual([])
    second.resolve(active(4, "four"))
    await availability

    expect({ order, revision: handle.currentRevision, syncCalls: sync.mock.calls.length }).toEqual({
      order: ["update:4", "available"],
      revision: 4,
      syncCalls: 2,
    })
    handle.unregister()
  })

  it("holds bootstrap and availability across a hint-created dirty successor", async () => {
    const first = deferred<ControlSyncResult>()
    const second = deferred<ControlSyncResult>()
    const order: string[] = []
    let calls = 0
    const { manager, sync } = setup(async () => (++calls === 1 ? first.promise : second.promise))
    const handle = manager.observe(params((update) => (order.push(`update:${update.sourceRevision}`), "applied")))
    await waitFor(() => sync.mock.calls.length === 1)

    manager.hint({ invocationId: "binv_1", sourceRevision: 4 }, false)
    const bootstrap = manager.bootstrap([], () => order.push("bootstrap"))
    const availability = manager.enqueueAdapter(() => order.push("available"))
    first.resolve(active(3, "three"))
    await waitFor(() => sync.mock.calls.length === 2)

    expect(order).not.toContain("bootstrap")
    expect(order).not.toContain("available")
    second.resolve(active(4, "four"))
    await Promise.all([bootstrap, availability])

    expect(order.slice(0, 2)).toEqual(["update:3", "update:4"])
    expect(order.slice(2).sort()).toEqual(["available", "bootstrap"])
    expect(handle.currentRevision).toBe(4)
    handle.unregister()
  })

  it("drains a higher hint received during the revision-3 network request", async () => {
    let resolveFirst!: (result: ControlSyncResult) => void
    const first = new Promise<ControlSyncResult>((resolve) => {
      resolveFirst = resolve
    })
    let calls = 0
    const revisions: number[] = []
    const { manager, sync } = setup(async () => (++calls === 1 ? first : active(4, "four")))
    const handle = manager.observe(params((update) => (revisions.push(update.sourceRevision), "applied")))

    manager.hint({ invocationId: "binv_1", sourceRevision: 4 }, false)
    resolveFirst(active(3, "three"))
    await waitFor(() => handle.currentRevision === 4)

    expect(revisions).toEqual([3, 4])
    expect(sync).toHaveBeenCalledTimes(2)
    handle.unregister()
  })

  it("starts revision-4 network sync while the revision-3 adapter callback is blocked", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const revisions: number[] = []
    const { manager, sync } = setup(async (request) =>
      request.knownSourceRevision === 2 && sync.mock.calls.length === 1 ? active(3, "three") : active(4, "four")
    )
    const handle = manager.observe(
      params(async (update) => {
        revisions.push(update.sourceRevision)
        if (update.sourceRevision === 3) await gate
        return "applied" as const
      })
    )
    await waitFor(() => revisions.length === 1)

    manager.hint({ invocationId: "binv_1", sourceRevision: 4 }, false)
    await waitFor(() => sync.mock.calls.length === 2)
    expect(revisions).toEqual([3])
    release()
    await waitFor(() => handle.currentRevision === 4)

    expect(revisions).toEqual([3, 4])
    handle.unregister()
  })

  it("normalizes backend restart reason from hints and bootstrap", () => {
    expect(parseCancellationReason("adapter_restart_required")).toBe("input_restart")
    expect(parseCancellationReason("input_restart")).toBe("input_restart")
    expect(parseCancellationReason("unknown")).toBeUndefined()
  })

  it("retries a transient restart with known and restart both equal to N", async () => {
    const cancelled = mock(() => {})
    let restartAttempts = 0
    const { manager, requests } = setup(async (request) => {
      if (request.restartRequiredRevision === 3) {
        restartAttempts++
        return restartAttempts === 1
          ? { kind: "retry" }
          : control({
              invocationId: "binv_1",
              status: "cancelled",
              sourceRevision: 3,
              reason: "input_restart",
            })
      }
      return active(3, "three")
    })
    manager.observe(params(() => "restart-required", cancelled))

    await waitFor(() => cancelled.mock.calls.length === 1)

    expect(
      requests
        .filter((request) => request.restartRequiredRevision !== undefined)
        .map((request) => [request.knownSourceRevision, request.restartRequiredRevision])
    ).toEqual([
      [3, 3],
      [3, 3],
    ])
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it("schedules a 15-second lease renewal at two-thirds TTL with a capped ack budget", async () => {
    const scheduler = new FakeScheduler()
    const now = 1_000
    const { manager, requests } = setup(async () => active(2, undefined, new Date(now + 15_000).toISOString()), {
      now: () => now,
      scheduler,
    })
    const handle = manager.observe({ ...params(), claimTtlSeconds: 15 })
    await handle.sync()

    expect({ delays: scheduler.pendingDelays, ackTimeoutMs: requests[0]?.ackTimeoutMs }).toEqual({
      delays: [10_000],
      ackTimeoutMs: 2_500,
    })
    handle.unregister()
  })

  it("renews from authoritative expiry while an adapter callback remains blocked", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const { manager, sync } = setup(
      async () => {
        calls++
        return calls === 1 ? active(3, "three", expires(12)) : active(3, undefined, expires(60_000))
      },
      { minRenewDelayMs: 2 }
    )
    const handle = manager.observe(
      params(async () => {
        await gate
        return "applied" as const
      })
    )

    await waitFor(() => sync.mock.calls.length >= 2)
    expect(handle.currentRevision).toBe(2)
    release()
    await waitFor(() => handle.currentRevision === 3)
    handle.unregister()
  })

  it("treats not-found as terminal without inventing cancellation", async () => {
    const cancelled = mock(() => {})
    const { manager, sync } = setup(async () => ({ kind: "not_found" }))
    const handle = manager.observe(params(() => "applied", cancelled))
    await waitFor(() => sync.mock.calls.length === 1)
    await Bun.sleep(10)

    manager.hint({ invocationId: "binv_1", sourceRevision: 3 }, false)
    await Bun.sleep(5)
    expect({
      syncCalls: sync.mock.calls.length,
      cancellations: cancelled.mock.calls.length,
      sealing: handle.sealing,
    }).toEqual({
      syncCalls: 1,
      cancellations: 0,
      sealing: undefined,
    })
  })

  it("fails a sealed-to-plaintext downgrade closed and requests restart", async () => {
    const fakeSealing = {
      streamId: "stream_1",
      replyKeyGeneration: 1,
      replySenderId: "bot_1",
      replySsk: new Uint8Array(32),
      callbackToken: "callback_secret",
    }
    const callback = mock(() => "applied" as const)
    const { manager, requests } = setup(async (request) => {
      if (request.restartRequiredRevision === 3) return { kind: "retry" }
      return active(3, "must not surface")
    })
    const handle = manager.observe({
      ...params(callback),
      sealed: {
        identity: { publicKeyId: "bik_1", publicKeyBase64: "x", privateKey: {} as CryptoKey },
        streamId: "stream_1",
        callbackToken: "callback_secret",
        sealing: fakeSealing,
      },
    })

    await waitFor(() => requests.some((request) => request.restartRequiredRevision === 3))
    expect({ callbackCalls: callback.mock.calls.length, restart: requests.at(-1)?.restartRequiredRevision }).toEqual({
      callbackCalls: 0,
      restart: 3,
    })
    handle.unregister()
  })

  it("ignores revision-2 cancellation while revision 3 is delivering and terminalizes once at revision 3", async () => {
    const callbackGate = deferred<void>()
    const revisions: number[] = []
    const cancelled = mock((_cancellation: unknown) => {})
    let calls = 0
    const { manager } = setup(
      async () =>
        ++calls === 1
          ? active(3, "three")
          : control({ invocationId: "binv_1", status: "cancelled", sourceRevision: 2, reason: "source_deleted" }),
      { retryDelayMs: 1_000 }
    )
    const handle = manager.observe(
      params(async (update) => {
        revisions.push(update.sourceRevision)
        await callbackGate.promise
        return "applied" as const
      }, cancelled)
    )
    await waitFor(() => revisions.length === 1)

    const staleSync = handle.sync()
    await waitFor(() => calls === 2)
    expect(cancelled).toHaveBeenCalledTimes(0)
    manager.hint({ invocationId: "binv_1", sourceRevision: 3, reason: "source_deleted" }, true)
    callbackGate.resolve()
    await staleSync
    await waitFor(() => cancelled.mock.calls.length === 1)

    manager.hint({ invocationId: "binv_1", sourceRevision: 4, reason: "source_deleted" }, true)
    await flushMicrotasks()
    expect({ revisions, cancellations: cancelled.mock.calls }).toEqual({
      revisions: [3],
      cancellations: [[{ invocationId: "binv_1", sourceRevision: 3, reason: "source_deleted" }]],
    })
  })

  it("clears renewal timers after cancellation, not-found, and unregister", async () => {
    const cancellationScheduler = new FakeScheduler()
    const cancellation = setup(async () => active(2), { scheduler: cancellationScheduler })
    const cancelled = mock(() => {})
    const cancellationHandle = cancellation.manager.observe(params(() => "applied", cancelled))
    await cancellationHandle.sync()
    cancellation.manager.hint({ invocationId: "binv_1", sourceRevision: 2, reason: "source_deleted" }, true)
    await waitFor(() => cancelled.mock.calls.length === 1)

    const notFoundScheduler = new FakeScheduler()
    let notFoundCalls = 0
    const notFound = setup(async () => (++notFoundCalls === 1 ? active(2) : { kind: "not_found" }), {
      scheduler: notFoundScheduler,
    })
    const notFoundHandle = notFound.manager.observe(params())
    await notFoundHandle.sync()
    await notFoundHandle.sync()

    const unregisterScheduler = new FakeScheduler()
    const unregister = setup(async () => active(2), { scheduler: unregisterScheduler })
    const unregisterHandle = unregister.manager.observe(params())
    await unregisterHandle.sync()
    unregisterHandle.unregister()

    expect({
      cancellationPending: cancellationScheduler.pendingCount,
      notFoundPending: notFoundScheduler.pendingCount,
      unregisterPending: unregisterScheduler.pendingCount,
    }).toEqual({ cancellationPending: 0, notFoundPending: 0, unregisterPending: 0 })

    cancellationScheduler.advanceBy(120_000)
    notFoundScheduler.advanceBy(120_000)
    unregisterScheduler.advanceBy(120_000)
    await flushMicrotasks()

    expect({
      cancellationCalls: cancellation.sync.mock.calls.length,
      notFoundCalls: notFound.sync.mock.calls.length,
      unregisterCalls: unregister.sync.mock.calls.length,
      firedTimers: cancellationScheduler.firedCount + notFoundScheduler.firedCount + unregisterScheduler.firedCount,
    }).toEqual({ cancellationCalls: 1, notFoundCalls: 2, unregisterCalls: 1, firedTimers: 0 })
  })

  it("terminalizes immediately, scrubs sealing, and survives a throwing cancellation callback", async () => {
    const cancelled = mock(() => {
      throw new Error("adapter failure")
    })
    const { manager } = setup(async () => active(2))
    const handle = manager.observe({
      ...params(() => "applied", cancelled),
      sealed: {
        identity: { publicKeyId: "bik_1", publicKeyBase64: "x", privateKey: {} as CryptoKey },
        streamId: "stream_1",
        callbackToken: "callback_secret",
        sealing: {
          streamId: "stream_1",
          replyKeyGeneration: 1,
          replySenderId: "bot_1",
          replySsk: new Uint8Array(32),
          callbackToken: "callback_secret",
        },
      },
    })

    manager.hint({ invocationId: "binv_1", sourceRevision: 2, reason: "source_deleted" }, true)
    expect(handle.sealing).toBeUndefined()
    await waitFor(() => cancelled.mock.calls.length === 1)
  })

  it("dispose invalidates a cancellation blocked on the adapter queue", async () => {
    const gate = deferred<void>()
    const cancelled = mock(() => {})
    const { manager } = setup(async () => active(3, "three"))
    const handle = manager.observe(
      params(async () => {
        await gate.promise
        return "applied" as const
      }, cancelled)
    )
    await flushMicrotasks()

    manager.hint({ invocationId: "binv_1", sourceRevision: 3, reason: "source_deleted" }, true)
    handle.dispose()
    gate.resolve()
    await flushMicrotasks()

    expect(cancelled).toHaveBeenCalledTimes(0)
  })

  it("same-ID replacement invalidates a cancellation blocked on the adapter queue", async () => {
    const gate = deferred<void>()
    const cancelled = mock(() => {})
    let calls = 0
    const { manager } = setup(async () => (++calls === 1 ? active(3, "three") : active(2)))
    manager.observe(
      params(async () => {
        await gate.promise
        return "applied" as const
      }, cancelled)
    )
    await flushMicrotasks()

    manager.hint({ invocationId: "binv_1", sourceRevision: 3, reason: "source_deleted" }, true)
    const replacement = manager.observe(params())
    gate.resolve()
    await flushMicrotasks()

    expect(cancelled).toHaveBeenCalledTimes(0)
    replacement.unregister()
  })

  it("disconnect suppresses a queued cancellation callback", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancelled = mock(() => {})
    const { manager } = setup(async () => active(3, "three"))
    manager.observe(
      params(async () => {
        await gate
        return "applied" as const
      }, cancelled)
    )
    await Bun.sleep(0)
    manager.hint({ invocationId: "binv_1", sourceRevision: 3, reason: "source_deleted" }, true)
    manager.stop()
    release()
    await Bun.sleep(5)

    expect(cancelled).toHaveBeenCalledTimes(0)
  })

  it("aborts an old generation on duplicate registration", async () => {
    const signals: AbortSignal[] = []
    const { manager } = setup(async (request) => {
      signals.push(request.signal)
      return new Promise<ControlSyncResult>((resolve) => {
        request.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true })
      })
    })
    manager.observe(params())
    await waitFor(() => signals.length === 1)
    const replacement = manager.observe(params())
    await waitFor(() => signals.length === 2)

    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    replacement.unregister()
  })

  it("awaits missed update and cancellation recovery before bootstrap callback", async () => {
    const order: string[] = []
    const { manager } = setup(async () => active(3, "three"))
    manager.observe(params(() => (order.push("update"), "applied")))

    await manager.bootstrap([], () => order.push("bootstrap"))

    expect(order).toEqual(["update", "bootstrap"])
    manager.stop()
  })

  it("bootstrap terminalizes a local observation absent from owned-claim hints", async () => {
    const order: string[] = []
    const { manager } = setup(async () => active(2))
    manager.observe(
      params(
        () => "applied",
        () => void order.push("cancel")
      )
    )

    await manager.bootstrap([{ invocationId: "binv_1", sourceRevision: 3, reason: "adapter_restart_required" }], () =>
      order.push("bootstrap")
    )

    expect(order).toEqual(["cancel", "bootstrap"])
    manager.stop()
  })
})
