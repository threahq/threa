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
import { FakeScheduler, deferred, waitFor } from "./transport-test-helpers"

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
  onCancelled: ObserveClaimParams["callbacks"]["onCancelled"] = () => {},
  onClaimLost?: ObserveClaimParams["callbacks"]["onClaimLost"]
): ObserveClaimParams {
  return {
    invocationId: "binv_1",
    claimToken: "claim_secret",
    sourceRevision: 2,
    claimTtlSeconds: 60,
    callbacks: { onInputUpdated, onCancelled, ...(onClaimLost ? { onClaimLost } : {}) },
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

    await waitFor(() => updates.length === 1)

    expect({ updates, syncCalls: sync.mock.calls.length }).toEqual({
      updates: [expect.objectContaining({ sourceRevision: 3, promptMarkdown: "authoritative", attachmentRefs: [] })],
      syncCalls: 1,
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

    expect([order.includes("bootstrap"), order.includes("available")]).toEqual([false, false])
    second.resolve(active(4, "four"))
    await Promise.all([bootstrap, availability])

    expect({ updates: order.slice(0, 2), adapters: order.slice(2).sort() }).toEqual({
      updates: ["update:3", "update:4"],
      adapters: ["available", "bootstrap"],
    })
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
    await waitFor(() => revisions.length === 2)

    expect({ revisions, syncCalls: sync.mock.calls.length }).toEqual({ revisions: [3, 4], syncCalls: 2 })
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
    await waitFor(() => revisions.length === 2)

    expect(revisions).toEqual([3, 4])
    handle.unregister()
  })

  it("normalizes backend restart reason from hints and bootstrap", () => {
    expect(["adapter_restart_required", "input_restart", "unknown"].map(parseCancellationReason)).toEqual([
      "input_restart",
      "input_restart",
      undefined,
    ])
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
              claimExpiresAt: null,
              sourceRevision: 3,
              reason: "input_restart",
            })
      }
      return active(3, "three")
    })
    manager.observe(params(() => "restart-required", cancelled))

    await waitFor(() => cancelled.mock.calls.length === 1)

    expect({
      restarts: requests
        .filter((request) => request.restartRequiredRevision !== undefined)
        .map((request) => [request.knownSourceRevision, request.restartRequiredRevision]),
      cancellations: cancelled.mock.calls.length,
    }).toEqual({
      restarts: [
        [3, 3],
        [3, 3],
      ],
      cancellations: 1,
    })
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
    const { manager, sync, requests } = setup(
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
    expect(requests.at(-1)?.minimumSourceRevision).toBe(2)
    release()
    await handle.sync()
    await handle.sync()
    expect(requests.at(-1)?.minimumSourceRevision).toBe(3)
    handle.unregister()
  })

  it("reports terminal not-found as claim loss without inventing cancellation", async () => {
    const cancelled = mock(() => {})
    const lost = mock(() => {})
    const { manager, sync } = setup(async () => ({ kind: "not_found" }))
    const handle = manager.observe(params(() => "applied", cancelled, lost))
    await handle.sync()

    manager.hint({ invocationId: "binv_1", sourceRevision: 3 }, false)
    await Bun.sleep(5)
    expect({
      syncCalls: sync.mock.calls.length,
      cancellations: cancelled.mock.calls.length,
      losses: lost.mock.calls.length,
    }).toEqual({
      syncCalls: 1,
      cancellations: 0,
      losses: 1,
    })
  })

  it("fails a sealed-to-plaintext downgrade closed and requests restart", async () => {
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
    const cancelled = mock(() => {})
    let calls = 0
    const { manager } = setup(
      async () =>
        ++calls === 1
          ? active(3, "three")
          : control({
              invocationId: "binv_1",
              status: "cancelled",
              claimExpiresAt: null,
              sourceRevision: 2,
              reason: "source_deleted",
            }),
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
    expect({ revisions, cancellations: cancelled.mock.calls.length }).toEqual({
      revisions: [3],
      cancellations: 1,
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

  it("terminalizes immediately and survives a throwing cancellation callback", async () => {
    const cancelled = mock(() => {
      throw new Error("adapter failure")
    })
    const { manager } = setup(async () => active(2))
    manager.observe({
      ...params(() => "applied", cancelled),
      sealed: {
        identity: { publicKeyId: "bik_1", publicKeyBase64: "x", privateKey: {} as CryptoKey },
        streamId: "stream_1",
        callbackToken: "callback_secret",
      },
    })

    manager.hint({ invocationId: "binv_1", sourceRevision: 2, reason: "source_deleted" }, true)
    await waitFor(() => cancelled.mock.calls.length === 1)
  })

  it("aborts a blocked update synchronously before its queued cancellation callback", async () => {
    const gate = deferred<void>()
    const cancelled = mock(() => {})
    let updateSignal: AbortSignal | undefined
    const { manager, requests } = setup(async () => active(3, "three"))
    const handle = manager.observe(
      params(async (_update, signal) => {
        updateSignal = signal
        await gate.promise
        return "applied" as const
      }, cancelled)
    )
    await waitFor(() => updateSignal !== undefined)

    manager.hint({ invocationId: "binv_1", sourceRevision: 3, reason: "source_deleted" }, true)

    expect({ aborted: updateSignal!.aborted, cancellations: cancelled.mock.calls.length }).toEqual({
      aborted: true,
      cancellations: 0,
    })
    gate.resolve()
    await waitFor(() => cancelled.mock.calls.length === 1)
    expect({ minimumSourceRevision: requests.at(-1)?.minimumSourceRevision, requests: requests.length }).toEqual({
      minimumSourceRevision: 2,
      requests: 1,
    })
  })

  it("aborts a blocked update synchronously on claim loss", async () => {
    const gate = deferred<void>()
    const lost = mock(() => {})
    let updateSignal: AbortSignal | undefined
    let calls = 0
    const { manager, requests } = setup(async () => (++calls === 1 ? active(3, "three") : { kind: "not_found" }))
    const handle = manager.observe(
      params(
        async (_update, signal) => {
          updateSignal = signal
          await gate.promise
          return "applied" as const
        },
        () => {},
        lost
      )
    )
    await waitFor(() => updateSignal !== undefined)

    void handle.sync()
    await waitFor(() => updateSignal!.aborted)
    expect(lost).toHaveBeenCalledTimes(0)

    gate.resolve()
    await waitFor(() => lost.mock.calls.length === 1)
    expect(requests.at(-1)?.minimumSourceRevision).toBe(2)
  })

  it("aborts blocked updates on unregister and manager stop", async () => {
    const unregisterGate = deferred<void>()
    let unregisterSignal: AbortSignal | undefined
    const unregister = setup(async () => active(3, "three"))
    const unregisterHandle = unregister.manager.observe(
      params(async (_update, signal) => {
        unregisterSignal = signal
        await unregisterGate.promise
        return "applied" as const
      })
    )
    await waitFor(() => unregisterSignal !== undefined)
    unregisterHandle.unregister()

    const stopGate = deferred<void>()
    let stopSignal: AbortSignal | undefined
    const stop = setup(async () => active(3, "three"))
    stop.manager.observe(
      params(async (_update, signal) => {
        stopSignal = signal
        await stopGate.promise
        return "applied" as const
      })
    )
    await waitFor(() => stopSignal !== undefined)
    stop.manager.stop()

    expect({ unregister: unregisterSignal!.aborted, stop: stopSignal!.aborted }).toEqual({
      unregister: true,
      stop: true,
    })
    unregisterGate.resolve()
    stopGate.resolve()
    await flushMicrotasks()
    expect(unregister.requests.at(-1)?.minimumSourceRevision).toBe(2)
  })

  it("isolates update abort signals when an invocation ID is reused", async () => {
    const oldGate = deferred<void>()
    let oldSignal: AbortSignal | undefined
    let newSignal: AbortSignal | undefined
    const { manager } = setup(async () => active(3, "three"))
    manager.observe(
      params(async (_update, signal) => {
        oldSignal = signal
        await oldGate.promise
        return "applied" as const
      })
    )
    await waitFor(() => oldSignal !== undefined)

    const replacement = manager.observe(
      params((_update, signal) => {
        newSignal = signal
        return "applied"
      })
    )
    expect(oldSignal!.aborted).toBe(true)
    oldGate.resolve()
    await waitFor(() => newSignal !== undefined)

    expect([oldSignal!.aborted, newSignal!.aborted]).toEqual([true, false])
    replacement.unregister()
    expect(newSignal!.aborted).toBe(true)
  })

  it("dispose invalidates claim loss blocked on the adapter queue", async () => {
    const gate = deferred<void>()
    const lost = mock(() => {})
    let calls = 0
    const { manager } = setup(async () => (++calls === 1 ? active(3, "three") : { kind: "not_found" }))
    const handle = manager.observe(
      params(
        async () => {
          await gate.promise
          return "applied" as const
        },
        () => {},
        lost
      )
    )
    await flushMicrotasks()

    void handle.sync()
    await waitFor(() => calls === 2)
    handle.dispose()
    gate.resolve()
    await flushMicrotasks()

    expect(lost).toHaveBeenCalledTimes(0)
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
})
