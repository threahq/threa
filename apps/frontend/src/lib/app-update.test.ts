import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AppUpdateController,
  AppUpdateLifecycle,
  APP_UPDATE_APPLY_TIMEOUT_MS,
  APP_UPDATE_RELOAD_CONFIRM_TIMEOUT_MS,
  createBrowserAppUpdateLifecycle,
  fetchLatestVersion,
} from "./app-update"
import { SW_MSG_APPLY_UPDATE, SW_MSG_QUERY_STATUS, SW_MSG_STATUS_REPLY } from "./sw-messages"

class FakeMessagePort extends EventTarget {
  other: FakeMessagePort | undefined
  private _onmessage: ((event: MessageEvent) => void) | null = null

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this._onmessage
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    if (this._onmessage) this.removeEventListener("message", this._onmessage as EventListener)
    this._onmessage = handler
    if (handler) this.addEventListener("message", handler as EventListener)
  }

  postMessage(data: unknown) {
    this.other?.dispatchEvent(new MessageEvent("message", { data }))
  }

  start() {}
  close() {}
}

class FakeMessageChannel {
  port1 = new FakeMessagePort()
  port2 = new FakeMessagePort()
  constructor() {
    this.port1.other = this.port2
    this.port2.other = this.port1
  }
}

class FakeWorker extends EventTarget {
  state: ServiceWorkerState
  scriptURL = "/sw.js"
  onStatus: () => { version: string; buildId: string; ready: boolean }
  onApply?: () => void

  constructor(state: ServiceWorkerState, onStatus: () => { version: string; buildId: string; ready: boolean }) {
    super()
    this.state = state
    this.onStatus = onStatus
  }

  postMessage(data: unknown, transfer?: Transferable[]) {
    const message = data as { type?: string; buildId?: string }
    if (message.type === SW_MSG_QUERY_STATUS) {
      const port = transfer?.[0] as FakeMessagePort | undefined
      const status = this.onStatus()
      queueMicrotask(() => port?.postMessage({ type: SW_MSG_STATUS_REPLY, ...status }))
    }
    if (message.type === SW_MSG_APPLY_UPDATE) {
      this.onApply?.()
    }
  }
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: FakeWorker | null = null
  getRegistration: ReturnType<typeof vi.fn>
  ready: Promise<unknown>

  constructor(registration: FakeServiceWorkerRegistration) {
    super()
    this.getRegistration = vi.fn(async () => registration)
    this.ready = Promise.resolve(registration)
  }
}

class FakeServiceWorkerRegistration extends EventTarget {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  active: FakeWorker | null = null
  update = vi.fn(async () => {})
}

function createTestLifecycle(): AppUpdateLifecycle {
  const callbacks = {
    online: new Set<() => void>(),
    visible: new Set<() => void>(),
    pageshow: new Set<(event: PageTransitionEvent) => void>(),
  }
  return {
    onOnline: (cb) => {
      callbacks.online.add(cb)
      return () => callbacks.online.delete(cb)
    },
    onVisible: (cb) => {
      callbacks.visible.add(cb)
      return () => callbacks.visible.delete(cb)
    },
    onPageshow: (cb) => {
      callbacks.pageshow.add(cb)
      return () => callbacks.pageshow.delete(cb)
    },
  }
}

describe("AppUpdateController", () => {
  let container: FakeServiceWorkerContainer
  let registration: FakeServiceWorkerRegistration
  let lifecycle: ReturnType<typeof createTestLifecycle>
  let reload: () => void
  let controller: AppUpdateController

  beforeEach(() => {
    vi.stubGlobal("MessageChannel", FakeMessageChannel)
    registration = new FakeServiceWorkerRegistration()
    container = new FakeServiceWorkerContainer(registration)
    lifecycle = createTestLifecycle()
    reload = vi.fn() as () => void
  })

  afterEach(() => {
    controller?.dispose()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function makeController(opts?: { isDev?: boolean; buildInfo?: { version: string; buildId: string } }) {
    controller = new AppUpdateController({
      serviceWorker: container as unknown as ServiceWorkerContainer,
      fetchLatestVersion: async () => null,
      buildInfo: opts?.buildInfo ?? { version: "A", buildId: "A" },
      isDev: opts?.isDev ?? false,
      pollIntervalMs: 300_000,
      lifecycle,
      reload,
    })
    return controller
  }

  function stateSnapshot() {
    return { ...controller.getState() }
  }

  it("should retarget retry when a newer worker replaces the accepted build", async () => {
    vi.useFakeTimers()
    const active = new FakeWorker("activated", () => ({ version: "A", buildId: "A", ready: true }))
    const b = new FakeWorker("installed", () => ({ version: "B", buildId: "B", ready: true }))
    const c = new FakeWorker("installing", () => ({ version: "C", buildId: "C", ready: true }))
    registration.active = container.controller = active
    registration.waiting = b
    makeController()
    await controller.start()
    const applying = controller.apply()
    registration.installing = c
    registration.dispatchEvent(new Event("updatefound"))
    b.state = "redundant"
    c.state = "installed"
    registration.waiting = c
    registration.installing = null
    c.dispatchEvent(new Event("statechange"))
    await applying
    expect(stateSnapshot()).toMatchObject({
      phase: "failed",
      failure: "activation-failed",
      readyBuildId: "C",
      readyVersion: "C",
    })

    c.onApply = () => {
      c.state = "activated"
      registration.waiting = null
      registration.active = container.controller = c
      container.dispatchEvent(new Event("controllerchange"))
    }
    const retry = controller.apply()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reload).toHaveBeenCalledOnce()
    expect(stateSnapshot().phase).toBe("applying")
    await vi.advanceTimersByTimeAsync(APP_UPDATE_RELOAD_CONFIRM_TIMEOUT_MS)
    await retry
  })

  it("should not claim current after the worker check fails for a same-version rebuild", async () => {
    registration.update = vi.fn(async () => {
      throw new Error("offline worker endpoint")
    })
    controller = new AppUpdateController({
      serviceWorker: container as unknown as ServiceWorkerContainer,
      fetchLatestVersion: async () => "A",
      buildInfo: { version: "A", buildId: "A@old" },
      isDev: false,
      pollIntervalMs: 300_000,
      lifecycle,
      reload,
    })
    await controller.check()
    expect(stateSnapshot()).toMatchObject({ phase: "unavailable", failure: "check-failed", readyBuildId: null })
  })

  it("starts in current phase in dev", () => {
    makeController({ isDev: true })
    expect(stateSnapshot().phase).toBe("current")
  })

  it("adopts a waiting worker and reports ready", async () => {
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = worker
    makeController()
    await controller.start()
    expect(stateSnapshot().phase).toBe("ready")
    expect(stateSnapshot().readyVersion).toBe("B")
    expect(stateSnapshot().readyBuildId).toBe("B")
  })

  it("waits for an installing worker to become ready", async () => {
    const worker = new FakeWorker("installing", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.installing = worker
    makeController()
    const promise = controller.start()
    expect(stateSnapshot().phase).toBe("idle")
    worker.state = "installed"
    worker.dispatchEvent(new Event("statechange"))
    await promise
    expect(stateSnapshot().phase).toBe("ready")
  })

  it("should announce a download that finishes after another foreground check", async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker("installing", () => ({ version: "B", buildId: "B", ready: true }))
    registration.installing = worker
    makeController()
    await controller.start()
    await vi.advanceTimersByTimeAsync(0)
    await controller.check()
    expect(stateSnapshot().phase).toBe("downloading")

    registration.installing = null
    registration.waiting = worker
    worker.state = "installed"
    worker.dispatchEvent(new Event("statechange"))

    await vi.waitFor(() =>
      expect(stateSnapshot()).toMatchObject({ phase: "ready", readyVersion: "B", readyBuildId: "B" })
    )
  })

  it("check triggers update and reports ready when a worker is waiting", async () => {
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = worker
    makeController()
    await controller.start()
    await controller.check()
    expect(registration.update).toHaveBeenCalled()
    expect(stateSnapshot().phase).toBe("ready")
  })

  it("check reports current only once the server probe confirms this build is latest", async () => {
    const worker = new FakeWorker("activated", () => ({
      version: "A",
      buildId: "A",
      ready: true,
    }))
    container.controller = worker
    registration.active = worker
    makeController()
    await controller.start()
    // start() alone must not claim "current" from local worker identity
    // alone — that's true even before any server probe has ever run.
    expect(stateSnapshot().phase).not.toBe("current")
    ;(controller as unknown as { deps: { fetchLatestVersion: () => Promise<string | null> } }).deps.fetchLatestVersion =
      async () => "A"
    await controller.check()
    expect(stateSnapshot().phase).toBe("current")
  })

  it("does not report current when the active worker matches the running build but the server probe disagrees or fails", async () => {
    const worker = new FakeWorker("activated", () => ({
      version: "A",
      buildId: "A",
      ready: true,
    }))
    container.controller = worker
    registration.active = worker
    makeController()
    await controller.start()

    // Server reports a newer version we haven't downloaded — must not claim
    // "current" just because our own controller matches our own build.
    ;(controller as unknown as { deps: { fetchLatestVersion: () => Promise<string | null> } }).deps.fetchLatestVersion =
      async () => "C"
    await controller.check()
    expect(stateSnapshot().phase).not.toBe("current")

    // Probe failure (null) is equally not proof of "current".
    ;(controller as unknown as { deps: { fetchLatestVersion: () => Promise<string | null> } }).deps.fetchLatestVersion =
      async () => null
    await controller.check()
    expect(stateSnapshot().phase).not.toBe("current")
  })

  it("check reports unavailable when no service worker registration exists", async () => {
    container.getRegistration = vi.fn(async () => null)
    container.ready = Promise.resolve(null)
    makeController()
    await controller.start()
    await controller.check()
    expect(stateSnapshot().phase).toBe("unavailable")
  })

  it("serializes check calls so only one update probe runs at a time", async () => {
    makeController()
    await controller.start()
    const a = controller.check()
    const b = controller.check()
    await a
    await b
    expect(registration.update).toHaveBeenCalledOnce()
  })

  it("a stale failed check does not override a newer ready state", async () => {
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = worker
    makeController({
      buildInfo: { version: "A", buildId: "A" },
    })
    await controller.start()
    await controller.check()
    expect(stateSnapshot().phase).toBe("ready")

    const readyGeneration = controller["generation"]
    ;(controller as unknown as { fetchLatestVersion: () => Promise<string | null> }).fetchLatestVersion = async () => {
      // Simulate a slow, stale check that was already in flight.
      await new Promise((resolve) => setTimeout(resolve, 0))
      return null
    }
    // Force the internal doCheck to think it is older by restoring generation after the await.
    const genBefore = (controller as unknown as { generation: number }).generation
    ;(controller as unknown as { generation: number }).generation = readyGeneration - 1
    await (controller as unknown as { doCheck: () => Promise<void> }).doCheck()
    ;(controller as unknown as { generation: number }).generation = genBefore
    expect(stateSnapshot().phase).toBe("ready")
  })

  it("apply messages the waiting worker, reloads on controllerchange, times out (not forever) if navigation never confirms, and can retry", async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    worker.onApply = () => {
      worker.state = "activated"
      registration.active = worker
      registration.waiting = null
      container.controller = worker
      container.dispatchEvent(new Event("controllerchange"))
    }
    registration.waiting = worker
    makeController()
    await controller.start()
    await controller.check()

    const applyPromise = controller.apply()
    expect(stateSnapshot().phase).toBe("applying")

    // The fake reload() never actually navigates, so apply() must not stay
    // pending (or "applying") forever — the bounded confirm timeout has to
    // fire and reset the guard.
    await vi.advanceTimersByTimeAsync(APP_UPDATE_RELOAD_CONFIRM_TIMEOUT_MS + 100)
    await applyPromise
    expect(reload).toHaveBeenCalledOnce()
    expect(stateSnapshot().phase).toBe("failed")
    expect(stateSnapshot().failure).toBe("activation-timeout")

    const retryPromise = controller.apply()
    await vi.advanceTimersByTimeAsync(APP_UPDATE_RELOAD_CONFIRM_TIMEOUT_MS + 100)
    await retryPromise
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("apply can reload from an already-active newer worker", async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker("activated", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    container.controller = worker
    registration.active = worker
    makeController({ buildInfo: { version: "A", buildId: "A" } })
    await controller.start()
    const applyPromise = controller.apply()
    await vi.advanceTimersByTimeAsync(APP_UPDATE_RELOAD_CONFIRM_TIMEOUT_MS + 100)
    await applyPromise
    expect(reload).toHaveBeenCalledOnce()
  })

  it("apply fails when the waiting worker never activates", async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = worker
    makeController()
    await controller.start()
    await controller.check()
    const promise = controller.apply()
    await vi.advanceTimersByTimeAsync(APP_UPDATE_APPLY_TIMEOUT_MS + 500)
    await promise
    expect(stateSnapshot().phase).toBe("failed")
    expect(stateSnapshot().failure).toBe("activation-timeout")
    expect(reload).not.toHaveBeenCalled()
  })

  it("apply is single-flight while a reload is in progress", async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = worker
    makeController()
    await controller.start()
    await controller.check()
    // Guard is keyed on the in-flight operation itself (applyPromise), not on
    // the mutable target+phase pair, so both calls share the same attempt.
    const a = controller.apply()
    const b = controller.apply()
    expect(stateSnapshot().phase).toBe("applying")
    worker.onApply = () => {
      worker.state = "activated"
      registration.active = worker
      registration.waiting = null
      container.controller = worker
      container.dispatchEvent(new Event("controllerchange"))
    }
    await vi.advanceTimersByTimeAsync(APP_UPDATE_RELOAD_CONFIRM_TIMEOUT_MS + 100)
    await a
    await b
    expect(reload).toHaveBeenCalledOnce()
  })

  it("observes a controllerchange from another tab and reports ready", async () => {
    const active = new FakeWorker("activated", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    makeController({ buildInfo: { version: "A", buildId: "A" } })
    await controller.start()
    container.controller = active
    registration.active = active
    container.dispatchEvent(new Event("controllerchange"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stateSnapshot().phase).toBe("ready")
    expect(stateSnapshot().readyBuildId).toBe("B")
  })

  it("does not report ready or unconfirmed current for a controllerchange to the same build", async () => {
    const active = new FakeWorker("activated", () => ({
      version: "A",
      buildId: "A",
      ready: true,
    }))
    makeController({ buildInfo: { version: "A", buildId: "A" } })
    await controller.start()
    container.controller = active
    container.dispatchEvent(new Event("controllerchange"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A bare controllerchange to our own build (e.g. first install) is not a
    // server probe — it must not claim "ready" (nothing new) or "current"
    // (unconfirmed). A real check() is what earns "current".
    expect(stateSnapshot().phase).not.toBe("ready")
    expect(stateSnapshot().phase).not.toBe("current")
    ;(controller as unknown as { deps: { fetchLatestVersion: () => Promise<string | null> } }).deps.fetchLatestVersion =
      async () => "A"
    await controller.check()
    expect(stateSnapshot().phase).toBe("current")
  })

  it("pageshow after bfcache resets an expired applying state", async () => {
    makeController()
    await controller.start()
    ;(controller as unknown as { setState: (partial: Record<string, unknown>) => void }).setState({
      phase: "applying",
      readyVersion: "B",
      readyBuildId: "B",
    })
    ;(controller as unknown as { applyAttempt: { buildId: string; startedAt: number } | null }).applyAttempt = {
      buildId: "B",
      startedAt: Date.now() - 60_000,
    }
    const event = new PageTransitionEvent("pageshow", { persisted: true })
    await (controller as unknown as { handlePageshow: (event: PageTransitionEvent) => void }).handlePageshow(event)
    expect(stateSnapshot().phase).toBe("failed")
    expect(stateSnapshot().failure).toBe("activation-timeout")
  })

  it("createBrowserAppUpdateLifecycle returns unsubscribe functions", () => {
    const browserLifecycle = createBrowserAppUpdateLifecycle()
    const unsubscribeOnline = browserLifecycle.onOnline(() => {})
    const unsubscribeVisible = browserLifecycle.onVisible(() => {})
    const unsubscribePageshow = browserLifecycle.onPageshow(() => {})
    expect(typeof unsubscribeOnline).toBe("function")
    expect(typeof unsubscribeVisible).toBe("function")
    expect(typeof unsubscribePageshow).toBe("function")
    unsubscribeOnline()
    unsubscribeVisible()
    unsubscribePageshow()
  })

  it("emits check-failed when update() rejects and no ready worker is present", async () => {
    registration.update = vi.fn(async () => {
      throw new Error("network")
    })
    makeController()
    await controller.start()
    await controller.check()
    expect(stateSnapshot().phase).toBe("unavailable")
    expect(stateSnapshot().failure).toBe("check-failed")
  })

  it("emits download-failed when an installing worker becomes redundant", async () => {
    const worker = new FakeWorker("installing", () => ({
      version: "B",
      buildId: "B",
      ready: false,
    }))
    registration.installing = worker
    makeController()
    const promise = controller.start()
    worker.state = "redundant"
    worker.dispatchEvent(new Event("statechange"))
    await promise
    expect(stateSnapshot().phase).toBe("failed")
    expect(stateSnapshot().failure).toBe("download-failed")
  })

  it("reports ready from an already-active newer worker during check", async () => {
    const worker = new FakeWorker("activated", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    container.controller = worker
    registration.active = worker
    makeController({ buildInfo: { version: "A", buildId: "A" } })
    await controller.start()
    await controller.check()
    expect(stateSnapshot().phase).toBe("ready")
    expect(stateSnapshot().readyBuildId).toBe("B")
  })

  it("does not overwrite a ready build with unavailable when the worker has activated", async () => {
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = worker
    makeController({ buildInfo: { version: "A", buildId: "A" } })
    await controller.start()
    await controller.check()
    expect(stateSnapshot().phase).toBe("ready")

    // The waiting worker activated (e.g. via skipWaiting from another tab). A
    // later check with no waiting/installing and no server version must still
    // observe the active ready worker rather than downgrading to unavailable.
    worker.state = "activated"
    registration.waiting = null
    registration.active = worker
    container.controller = worker
    await controller.check()
    expect(stateSnapshot().phase).toBe("ready")
    expect(stateSnapshot().readyBuildId).toBe("B")
  })

  it("dismissedBuildId defaults to null and dismissNotice pins the passed id", async () => {
    makeController()
    expect(stateSnapshot().dismissedBuildId).toBeNull()
    await controller.start()
    controller.dismissNotice("B@123")
    expect(stateSnapshot().dismissedBuildId).toBe("B@123")
  })

  it("dismissNotice pins the id the caller passed, not the current readyBuildId", async () => {
    makeController()
    await controller.start()
    // No ready build observed yet; dismissing an id the worker never reported
    // must still be recorded verbatim rather than resolved against state.
    controller.dismissNotice("stale-build")
    expect(stateSnapshot().dismissedBuildId).toBe("stale-build")
    expect(stateSnapshot().readyBuildId).toBeNull()
  })

  it("dismissedBuildId survives later ordinary state observations", async () => {
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = worker
    makeController()
    await controller.start()
    await controller.check()
    expect(stateSnapshot().phase).toBe("ready")

    controller.dismissNotice("B")
    expect(stateSnapshot().dismissedBuildId).toBe("B")

    // Re-observing the same ready build on a later check must not clear the
    // dismissal — only an explicit dismissNotice call (or a fresh controller
    // from a full reload) changes it.
    await controller.check()
    expect(stateSnapshot().phase).toBe("ready")
    expect(stateSnapshot().dismissedBuildId).toBe("B")
  })

  it("start() is safe to call again after a synchronous dispose (React StrictMode)", async () => {
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = worker
    makeController()
    const addEventListenerSpy = vi.spyOn(registration, "addEventListener")

    // StrictMode's dev-only mount->cleanup->mount runs synchronously, before
    // the first start()'s `await this.getRegistration()` has settled.
    const first = controller.start()
    controller.dispose()
    const second = controller.start()
    await first
    await second

    // Only the surviving (second) start() attaches registration listeners; a
    // superseded first invocation must bail out after resuming from its await
    // instead of registering a duplicate updatefound listener and leaking a
    // second poll timer that would run forever.
    const updatefoundCalls = addEventListenerSpy.mock.calls.filter(([type]) => type === "updatefound")
    expect(updatefoundCalls.length).toBe(1)
    expect(stateSnapshot().phase).toBe("ready")

    // The controller must not be permanently disposed by the cycle.
    await controller.check()
    expect(registration.update).toHaveBeenCalled()
  })

  it("queryWorkerStatus (protocol boundary) treats a ready:false reply as no status at all", async () => {
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: false,
    }))
    registration.waiting = worker
    makeController()
    await controller.start()
    // A reply that isn't ready must not be advertised as a ready build.
    expect(stateSnapshot().phase).not.toBe("ready")
  })

  it("a synchronous throw from postMessage during a status query resolves to no status instead of hanging or rejecting", async () => {
    const worker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    const originalPostMessage = worker.postMessage.bind(worker)
    worker.postMessage = ((data: unknown, transfer?: Transferable[]) => {
      const message = data as { type?: string }
      if (message.type === SW_MSG_QUERY_STATUS) {
        throw new DOMException("worker is not controlling", "InvalidStateError")
      }
      return originalPostMessage(data, transfer)
    }) as typeof worker.postMessage
    registration.waiting = worker
    makeController()
    // Must settle (not hang) and must not throw/reject out of start().
    await expect(controller.start()).resolves.toBeUndefined()
    expect(stateSnapshot().phase).not.toBe("ready")
  })

  it("getRegistration is bounded even if the browser's registration lookup never settles", async () => {
    vi.useFakeTimers()
    container.getRegistration = vi.fn(() => new Promise(() => {}))
    container.ready = new Promise(() => {})
    makeController()
    const startPromise = controller.start()
    const checkPromise = controller.check()
    await vi.advanceTimersByTimeAsync(11_000)
    await startPromise
    await checkPromise
    // start()'s own getRegistration() resolved (bounded) and, since it also
    // schedules the deferred startup check, that check's own independent
    // getRegistration() bound needs its own 10s window too.
    await vi.advanceTimersByTimeAsync(11_000)
    // A registration lookup that never resolves must not hang startup or
    // check() forever — it degrades to "no registration" instead.
    expect(stateSnapshot().phase).toBe("unavailable")
  })

  it("startup drives a real update check without waiting for the poll interval", async () => {
    vi.useFakeTimers()
    makeController()
    await controller.start()
    expect(registration.update).not.toHaveBeenCalled()
    // Far short of the 5-minute poll interval.
    await vi.advanceTimersByTimeAsync(0)
    expect(registration.update).toHaveBeenCalled()
  })

  it("fetchLatestVersion bounds the network probe instead of fetching unboundedly", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ version: "A" })))
    await fetchLatestVersion()
    expect(fetchSpy).toHaveBeenCalledWith("/version.json", expect.objectContaining({ signal: expect.any(AbortSignal) }))
    fetchSpy.mockRestore()
  })

  it("a stale onControllerChange reply does not overwrite state while apply() is active", async () => {
    vi.useFakeTimers()
    const waitingWorker = new FakeWorker("installed", () => ({
      version: "B",
      buildId: "B",
      ready: true,
    }))
    registration.waiting = waitingWorker
    makeController()
    await controller.start()
    await controller.check()
    expect(stateSnapshot().phase).toBe("ready")

    // Another tab's worker activates concurrently and reports a THIRD build —
    // this must not flip phase away from "applying" once apply() has started.
    const otherTabWorker = new FakeWorker("activated", () => ({
      version: "C",
      buildId: "C",
      ready: true,
    }))
    const applyPromise = controller.apply()
    expect(stateSnapshot().phase).toBe("applying")

    container.controller = otherTabWorker
    container.dispatchEvent(new Event("controllerchange"))
    await vi.advanceTimersByTimeAsync(0)
    expect(stateSnapshot().phase).toBe("applying")

    await vi.advanceTimersByTimeAsync(APP_UPDATE_APPLY_TIMEOUT_MS + 500)
    await applyPromise
  })
})
