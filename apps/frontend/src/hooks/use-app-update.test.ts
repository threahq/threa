import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  currentAppVersion,
  isE2eBuild,
  reconcilePostReload,
  reloadForUpdate,
  shouldAnnounceControllerSwap,
  shouldAnnounceStalePage,
  shouldAnnounceWaiting,
  shouldRecoverForVersion,
  CLICK_UPDATE_TIMEOUT_MS,
  RELOAD_FALLBACK_TIMEOUT_MS,
} from "./use-app-update"
import * as swRecovery from "@/lib/sw-recovery"
import { SW_MSG_SKIP_WAITING } from "@/lib/sw-messages"

describe("isE2eBuild", () => {
  // The vite `define` isn't applied under vitest, so the bare `__E2E_BUILD__`
  // resolves to the global — stub it to stand in for the E2E vs. prod build.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("is false when the define wasn't applied (prod/unit build): the toast still fires", () => {
    expect(isE2eBuild()).toBe(false)
  })

  it("is true only in the E2E build, so announceIfWaiting suppresses the click-blocking toast", () => {
    vi.stubGlobal("__E2E_BUILD__", true)
    expect(isE2eBuild()).toBe(true)
  })

  it("is false when the flag is explicitly false", () => {
    vi.stubGlobal("__E2E_BUILD__", false)
    expect(isE2eBuild()).toBe(false)
  })
})

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

describe("shouldAnnounceControllerSwap", () => {
  it("announces when another client swapped the controller under this page", () => {
    expect(shouldAnnounceControllerSwap({ hadController: true, hasController: true, reloadPending: false })).toBe(true)
  })

  it("stays silent on the first-ever install claiming the page", () => {
    expect(shouldAnnounceControllerSwap({ hadController: false, hasController: true, reloadPending: false })).toBe(
      false
    )
  })

  it("stays silent when the SW was unregistered (recovery) — a reload follows", () => {
    expect(shouldAnnounceControllerSwap({ hadController: true, hasController: false, reloadPending: false })).toBe(
      false
    )
  })

  it("stays silent for this tab's own Reload click — reloadForUpdate reloads already", () => {
    expect(shouldAnnounceControllerSwap({ hadController: true, hasController: true, reloadPending: true })).toBe(false)
  })
})

describe("shouldAnnounceStalePage", () => {
  it("announces only on two known, differing versions not yet announced", () => {
    expect(shouldAnnounceStalePage("a", "b", null)).toBe(true)
    expect(shouldAnnounceStalePage("a", "a", null)).toBe(false)
    expect(shouldAnnounceStalePage("a", null, null)).toBe(false)
    expect(shouldAnnounceStalePage(null, "b", null)).toBe(false)
    expect(shouldAnnounceStalePage(null, null, null)).toBe(false)
  })

  it("stays silent for a target version already announced this session", () => {
    expect(shouldAnnounceStalePage("a", "b", "b")).toBe(false)
  })

  it("re-announces when an even newer version supersedes the announced one", () => {
    expect(shouldAnnounceStalePage("a", "c", "b")).toBe(true)
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

  const setServiceWorker = (
    registration: FakeRegistration | null,
    opts?: { controller?: unknown }
  ): { fire(type: string): void } => {
    const listeners: Record<string, Array<() => void>> = {}
    const sw = {
      getRegistration: vi.fn(async () => registration),
      // `controller` is the page's active worker. Present = something already
      // controls the page, so reloadForUpdate prefers a plain (offline-safe)
      // reload over the cache-wiping recovery.
      controller: opts?.controller ?? null,
      addEventListener: vi.fn((type: string, cb: () => void) => {
        ;(listeners[type] ??= []).push(cb)
      }),
      fire: (type: string) => listeners[type]?.forEach((cb) => cb()),
    }
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw })
    return sw
  }

  beforeEach(() => {
    sessionStorage.clear()
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

  it("recovers (cache wipe) only when nothing controls the page and there's no registration", async () => {
    setServiceWorker(null, { controller: null })
    await reloadForUpdate()
    expect(recoverySpy).toHaveBeenCalledWith({ force: true })
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it("plain-reloads (offline-safe) when a controller exists but no worker is parked", async () => {
    // Another tab already activated the new build: the controller is the new
    // worker, so a reload lands it — wiping the cache would be worse than offline.
    const registration = makeRegistration()
    setServiceWorker(registration, { controller: {} })

    await reloadForUpdate()

    expect(registration.update).toHaveBeenCalledOnce()
    expect(reloadSpy).toHaveBeenCalledOnce()
    expect(recoverySpy).not.toHaveBeenCalled()
  })

  it("recovers when no worker is parked and nothing controls the page", async () => {
    const registration = makeRegistration()
    setServiceWorker(registration, { controller: null })

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

  it("plain-reloads (never wipes) when controllerchange never fires", async () => {
    // iOS standalone drops controllerchange after skipWaiting — the fallback
    // must be an offline-safe reload, not a cache wipe that could strand a
    // flaky connection on a worker that already activated.
    vi.useFakeTimers()
    const waiting = makeWorker()
    setServiceWorker(makeRegistration({ waiting }), { controller: {} })

    await reloadForUpdate()
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(recoverySpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RELOAD_FALLBACK_TIMEOUT_MS)
    expect(reloadSpy).toHaveBeenCalledOnce()
    expect(recoverySpy).not.toHaveBeenCalled()
  })

  it("plain-reloads when the click-path update check hangs (stalled mobile network)", async () => {
    // registration.update() has no timeout of its own — unbounded, a stalled
    // network would leave the click looking dead. The bounded race must fall
    // through to the offline-safe plain reload.
    vi.useFakeTimers()
    const registration = makeRegistration()
    registration.update = vi.fn(() => new Promise(() => {})) as FakeRegistration["update"]
    setServiceWorker(registration, { controller: {} })

    const promise = reloadForUpdate()
    await vi.advanceTimersByTimeAsync(CLICK_UPDATE_TIMEOUT_MS)
    await promise

    expect(reloadSpy).toHaveBeenCalledOnce()
    expect(recoverySpy).not.toHaveBeenCalled()
  })

  it("marks a reload attempt so the next load can reconcile it", async () => {
    setServiceWorker(makeRegistration({ waiting: makeWorker() }))
    await reloadForUpdate()
    expect(sessionStorage.getItem("app-update-reload-attempt")).not.toBeNull()
  })

  describe("reconcilePostReload", () => {
    const RELOAD_KEY = "app-update-reload-attempt"
    let fetchSpy: ReturnType<typeof vi.spyOn>

    const mockVersion = (version: string | null, ok = true) => {
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok,
        json: async () => (version === null ? {} : { version }),
      } as Response)
    }
    const markReload = () => sessionStorage.setItem(RELOAD_KEY, String(Date.now()))

    afterEach(() => {
      fetchSpy?.mockRestore()
    })

    it("does nothing without a recent Reload click", async () => {
      mockVersion("anything-newer")
      expect(await reconcilePostReload()).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(recoverySpy).not.toHaveBeenCalled()
    })

    it("recovers when the running build differs from the server's latest (swap didn't take)", async () => {
      // The decisive signal: a successful version fetch proves we're online, and a
      // mismatch proves the Reload didn't boot us onto new code. Re-announcing
      // would loop forever, so force a clean boot.
      markReload()
      mockVersion(`${currentAppVersion() ?? "x"}-stale`)

      expect(await reconcilePostReload()).toBe(true)
      expect(recoverySpy).toHaveBeenCalledOnce()
      // Forced: this recovery only fires from a user Reload click (single-shot
      // flag), so it can't auto-loop; forcing keeps unrelated chunk-load
      // recoveries from exhausting the shared attempt cap and silently no-opping
      // the user's Reload.
      expect(recoverySpy).toHaveBeenCalledWith({ force: true })
    })

    it("wipes nothing when the running build already matches the latest", async () => {
      markReload()
      mockVersion(currentAppVersion())

      expect(await reconcilePostReload()).toBe(false)
      expect(recoverySpy).not.toHaveBeenCalled()
    })

    it("wipes nothing when the version can't be verified (offline)", async () => {
      // Offline-first: a failed fetch must never trigger a cache wipe, or we'd
      // brick a launch that has no network to refetch from.
      markReload()
      fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))

      expect(await reconcilePostReload()).toBe(false)
      expect(recoverySpy).not.toHaveBeenCalled()
    })

    it("consumes the flag so a later check doesn't recover again", async () => {
      markReload()
      mockVersion(`${currentAppVersion() ?? "x"}-stale`)

      expect(await reconcilePostReload()).toBe(true)
      expect(await reconcilePostReload()).toBe(false)
    })
  })

  describe("shouldRecoverForVersion", () => {
    it("recovers only on two known, differing versions", () => {
      expect(shouldRecoverForVersion("a", "b")).toBe(true)
      expect(shouldRecoverForVersion("a", "a")).toBe(false)
      expect(shouldRecoverForVersion("a", null)).toBe(false)
      expect(shouldRecoverForVersion(null, "b")).toBe(false)
      expect(shouldRecoverForVersion(null, null)).toBe(false)
    })
  })
})
