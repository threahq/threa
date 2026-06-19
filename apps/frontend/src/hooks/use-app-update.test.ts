import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reloadForUpdate, shouldNotifyUpdate, RELOAD_FALLBACK_TIMEOUT_MS } from "./use-app-update"
import { SW_MSG_SKIP_WAITING } from "@/lib/sw-messages"

const RUNNING = "abc1234"

describe("shouldNotifyUpdate", () => {
  it("notifies when the server build is newer and not yet announced", () => {
    expect(shouldNotifyUpdate("def5678", RUNNING, null)).toBe(true)
  })

  it("stays silent when the server build matches what's running", () => {
    expect(shouldNotifyUpdate(RUNNING, RUNNING, null)).toBe(false)
  })

  it("stays silent for a deploy already announced (the remount/refocus re-toast bug)", () => {
    // User saw the toast for def5678, dismissed it, kept working on the old
    // build. A remount + refocus re-runs the check with the same delta.
    expect(shouldNotifyUpdate("def5678", RUNNING, "def5678")).toBe(false)
  })

  it("notifies again only for a genuinely newer build", () => {
    expect(shouldNotifyUpdate("ghi9012", RUNNING, "def5678")).toBe(true)
  })

  it("stays silent on an empty/missing server version", () => {
    expect(shouldNotifyUpdate("", RUNNING, null)).toBe(false)
  })
})

describe("reloadForUpdate", () => {
  const originalLocation = window.location
  const swDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")
  let reloadSpy: ReturnType<typeof vi.fn>

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
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    if (swDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", swDescriptor)
    } else {
      // jsdom has no serviceWorker by default — drop the stub we added.
      delete (navigator as { serviceWorker?: unknown }).serviceWorker
    }
  })

  it("reloads immediately when no service worker registration exists", async () => {
    setServiceWorker(null)
    await reloadForUpdate()
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it("reloads immediately when no parked worker is available after update", async () => {
    const registration = makeRegistration()
    setServiceWorker(registration)

    await reloadForUpdate()

    expect(registration.update).toHaveBeenCalledOnce()
    expect(reloadSpy).toHaveBeenCalledOnce()
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
  })

  it("waits briefly for an installing worker before falling back", async () => {
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
  })

  it("reloads anyway when the worker never claims", async () => {
    vi.useFakeTimers()
    const waiting = makeWorker()
    setServiceWorker(makeRegistration({ waiting }))

    await reloadForUpdate()
    expect(reloadSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RELOAD_FALLBACK_TIMEOUT_MS)
    expect(reloadSpy).toHaveBeenCalledOnce()
  })
})
