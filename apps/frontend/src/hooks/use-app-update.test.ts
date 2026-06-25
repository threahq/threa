import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reloadForUpdate, shouldAnnounceWaiting, RELOAD_FALLBACK_TIMEOUT_MS } from "./use-app-update"
import * as swRecovery from "@/lib/sw-recovery"
import { SW_MSG_SKIP_WAITING } from "@/lib/sw-messages"

describe("shouldAnnounceWaiting", () => {
  // Distinct objects stand in for distinct parked workers — the gate keys on
  // worker identity, not a version string.
  const workerA = {} as ServiceWorker
  const workerB = {} as ServiceWorker

  it("stays silent when nothing is parked (no update, or a first-ever install)", () => {
    expect(shouldAnnounceWaiting(null, null)).toBe(false)
    expect(shouldAnnounceWaiting(undefined, null)).toBe(false)
  })

  it("announces a freshly parked build", () => {
    expect(shouldAnnounceWaiting(workerA, null)).toBe(true)
  })

  it("stays silent on the remount/refocus re-check of an already-announced build", () => {
    expect(shouldAnnounceWaiting(workerA, workerA)).toBe(false)
  })

  it("announces again only for a genuinely newer build (a new waiting worker)", () => {
    expect(shouldAnnounceWaiting(workerB, workerA)).toBe(true)
  })
})

describe("reloadForUpdate", () => {
  const originalLocation = window.location
  const swDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")
  let reloadSpy: ReturnType<typeof vi.fn>
  let recoverySpy: ReturnType<typeof vi.spyOn>

  type FakeWorker = ServiceWorker & { setState(state: ServiceWorkerState): void }
  type FakeRegistration = ServiceWorkerRegistration & {
    setInstalling(worker: FakeWorker | null): void
    setWaiting(worker: FakeWorker | null): void
  }

  function makeWorker(state: ServiceWorkerState = "installed"): FakeWorker {
    const listeners = new Set<() => void>()
    const worker = {
      state,
      postMessage: vi.fn(),
      addEventListener: vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === "statechange" && typeof cb === "function") listeners.add(cb as () => void)
      }),
      removeEventListener: vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === "statechange" && typeof cb === "function") listeners.delete(cb as () => void)
      }),
      setState(next: ServiceWorkerState) {
        worker.state = next
        for (const listener of listeners) listener()
      },
    }
    return worker as unknown as FakeWorker
  }

  function makeRegistration(opts?: { waiting?: FakeWorker | null; installing?: FakeWorker | null }): FakeRegistration {
    const registration: {
      waiting: FakeWorker | null
      installing: FakeWorker | null
      update: ReturnType<typeof vi.fn>
      setInstalling(worker: FakeWorker | null): void
      setWaiting(worker: FakeWorker | null): void
    } = {
      waiting: opts?.waiting ?? null,
      installing: opts?.installing ?? null,
      update: vi.fn(async () => registration),
      setInstalling(worker: FakeWorker | null) {
        registration.installing = worker
      },
      setWaiting(worker: FakeWorker | null) {
        registration.waiting = worker
      },
    }
    return registration as unknown as FakeRegistration
  }

  const setServiceWorker = (registration: FakeRegistration | null): { fire(type: string): void } => {
    const listeners: Record<string, Array<() => void>> = {}
    const sw = {
      getRegistration: vi.fn(async () => registration),
      addEventListener: vi.fn((type: string, cb: () => void) => {
        ;(listeners[type] ??= []).push(cb)
      }),
      fire: (type: string) => listeners[type]?.forEach((cb) => cb()),
    }
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw })
    return sw
  }

  beforeEach(() => {
    reloadSpy = vi.fn()
    // jsdom's location.reload() throws "Not implemented" — replace it with a spy.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    })
    // runSwRecovery would touch caches / fetch / getRegistrations that jsdom
    // lacks; stub it and assert it's the escalation taken.
    recoverySpy = vi.spyOn(swRecovery, "runSwRecovery").mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    recoverySpy.mockRestore()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    if (swDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", swDescriptor)
    } else {
      // jsdom has no serviceWorker by default — drop the stub we added.
      delete (navigator as { serviceWorker?: unknown }).serviceWorker
    }
  })

  it("escalates to recovery when no service worker registration exists", async () => {
    setServiceWorker(null)
    await reloadForUpdate()
    expect(recoverySpy).toHaveBeenCalledWith({ force: true })
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it("escalates to recovery when no parked worker is available after update", async () => {
    const registration = makeRegistration()
    setServiceWorker(registration)

    await reloadForUpdate()

    expect(registration.update).toHaveBeenCalledOnce()
    expect(recoverySpy).toHaveBeenCalledWith({ force: true })
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it("activates the parked worker and reloads once it takes control", async () => {
    const waiting = makeWorker()
    const registration = makeRegistration({ waiting })
    const sw = setServiceWorker(registration)

    await reloadForUpdate()

    expect(waiting.postMessage).toHaveBeenCalledWith({ type: SW_MSG_SKIP_WAITING })
    expect(reloadSpy).not.toHaveBeenCalled()

    sw.fire("controllerchange")
    expect(reloadSpy).toHaveBeenCalledOnce()
    expect(recoverySpy).not.toHaveBeenCalled()
  })

  it("waits briefly for an installing worker before activating it", async () => {
    const installing = makeWorker("installing")
    const registration = makeRegistration({ installing })
    setServiceWorker(registration)

    const promise = reloadForUpdate()
    expect(reloadSpy).not.toHaveBeenCalled()

    registration.setWaiting(installing)
    installing.setState("installed")
    await promise

    expect(installing.postMessage).toHaveBeenCalledWith({ type: SW_MSG_SKIP_WAITING })
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(recoverySpy).not.toHaveBeenCalled()
  })

  it("escalates to recovery when the parked worker never claims", async () => {
    vi.useFakeTimers()
    const waiting = makeWorker()
    setServiceWorker(makeRegistration({ waiting }))

    await reloadForUpdate()
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(recoverySpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RELOAD_FALLBACK_TIMEOUT_MS)
    expect(recoverySpy).toHaveBeenCalledWith({ force: true })
    expect(reloadSpy).not.toHaveBeenCalled()
  })
})
