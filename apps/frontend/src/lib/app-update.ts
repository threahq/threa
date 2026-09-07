import { currentAppBuildId, currentAppVersion } from "@/lib/app-build"
import { SW_MSG_APPLY_UPDATE, SW_MSG_QUERY_STATUS, SW_MSG_STATUS_REPLY, SW_MSG_RUN_GC } from "@/lib/sw-messages"

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "applying"
  | "current"
  | "offline"
  | "unavailable"
  | "failed"

export type AppUpdateFailure = "check-failed" | "download-failed" | "activation-failed" | "activation-timeout"

export interface AppUpdateState {
  phase: AppUpdatePhase
  readyVersion: string | null
  readyBuildId: string | null
  latestVersion: string | null
  lastCheckedAt: Date | null
  failure: AppUpdateFailure | null
  /**
   * Build the user has explicitly dismissed a notice for, pinned by id. Never
   * cleared by ordinary state observations — only a new `dismissNotice` call or
   * a full page reload (which constructs a fresh controller) changes it. A
   * later `readyBuildId` that differs naturally reannounces.
   */
  dismissedBuildId: string | null
}

export interface WorkerStatusReply {
  type: typeof SW_MSG_STATUS_REPLY
  version: string
  buildId: string
  ready: true
}

export interface AppUpdateLifecycle {
  onOnline: (callback: () => void) => () => void
  onVisible: (callback: () => void) => () => void
  onPageshow: (callback: (event: PageTransitionEvent) => void) => () => void
}

export interface AppUpdateControllerDeps {
  serviceWorker: ServiceWorkerContainer | undefined
  fetchLatestVersion: () => Promise<string | null>
  buildInfo: { version: string | null; buildId: string | null }
  isDev: boolean
  pollIntervalMs: number
  lifecycle: AppUpdateLifecycle
  reload: () => void
}

export const APP_UPDATE_CHECK_TIMEOUT_MS = 10_000
export const APP_UPDATE_APPLY_TIMEOUT_MS = 10_000
export const APP_UPDATE_STATUS_TIMEOUT_MS = 1500
export const APP_UPDATE_APPLYING_MAX_AGE_MS = 30_000
export const APP_UPDATE_REGISTRATION_TIMEOUT_MS = 10_000
/** Bound on "did the reload we requested actually start navigating". */
export const APP_UPDATE_RELOAD_CONFIRM_TIMEOUT_MS = 5_000

export function createBrowserAppUpdateLifecycle(): AppUpdateLifecycle {
  return {
    onOnline: (callback) => {
      window.addEventListener("online", callback)
      return () => window.removeEventListener("online", callback)
    },
    onVisible: (callback) => {
      const wrapped = () => {
        if (document.visibilityState === "visible") callback()
      }
      document.addEventListener("visibilitychange", wrapped)
      return () => document.removeEventListener("visibilitychange", wrapped)
    },
    onPageshow: (callback) => {
      window.addEventListener("pageshow", callback)
      return () => window.removeEventListener("pageshow", callback)
    },
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

/**
 * Runs `fn` and turns both a synchronous throw and an async rejection into
 * `fallback` — the one place callers need to handle a failure boundary
 * (registration lookups, `registration.update()`, the version probe).
 */
async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Identifies one `apply()` call so a superseded attempt can recognize it lost the race. */
interface ApplyAttempt {
  buildId: string
  startedAt: number
}

/**
 * Shared coordinator for the app update lifecycle. One instance lives at app
 * lifetime; the React provider subscribes to its state. All lifecycle decisions
 * (ready, applying, failure) are pinned to observed worker identity, not to a
 * moving server latest version.
 *
 * Concurrency discipline: every async observation (`observeRegistration`,
 * `onUpdateFound`, `onControllerChange`, `trackInstallingWorker`) captures its
 * generation ONCE at the start of the observation and writes with that same
 * generation. `setState` drops any write whose generation is older than the
 * newest one already applied, so a slow observation that resolves after a
 * newer one (or after `apply()` began) cannot clobber it. This is why nothing
 * here generates a fresh generation per write — that would always "win" and
 * defeat the staleness check.
 */
export class AppUpdateController {
  private deps: AppUpdateControllerDeps
  private listeners = new Set<() => void>()
  private state: AppUpdateState
  private generation = 0
  private checkPromise: Promise<void> | null = null
  private applyPromise: Promise<void> | null = null
  private applyAttempt: ApplyAttempt | null = null
  private reloadPromise: Promise<void> | null = null
  private reloadResolve: (() => void) | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private startupCheckTimer: ReturnType<typeof setTimeout> | null = null
  private trackedInstallingWorkers = new WeakSet<ServiceWorker>()
  private unsubscribes: Array<() => void> = []
  private disposed = false
  private startEpoch = 0

  constructor(deps: AppUpdateControllerDeps) {
    this.deps = deps
    this.state = {
      phase: deps.isDev ? "current" : "idle",
      readyVersion: null,
      readyBuildId: null,
      latestVersion: null,
      lastCheckedAt: null,
      failure: null,
      dismissedBuildId: null,
    }
    // Bind once so `controller.check` etc. are stable, correctly-`this`-bound
    // references — the React hook hands these out directly via
    // useSyncExternalStore without re-wrapping them per render.
    this.getState = this.getState.bind(this)
    this.subscribe = this.subscribe.bind(this)
    this.start = this.start.bind(this)
    this.dispose = this.dispose.bind(this)
    this.check = this.check.bind(this)
    this.apply = this.apply.bind(this)
    this.dismissNotice = this.dismissNotice.bind(this)
  }

  getState(): AppUpdateState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private nextGeneration(): number {
    return ++this.generation
  }

  private setState(partial: Partial<AppUpdateState> & { _generation?: number }): void {
    if (this.disposed) return
    const incoming = partial._generation ?? this.generation
    if (incoming < this.generation) {
      // A stale async result is trying to overwrite newer state. Drop it.
      return
    }
    this.generation = incoming
    const next: AppUpdateState = { ...this.state }
    if (partial.phase !== undefined) next.phase = partial.phase
    if (partial.readyVersion !== undefined) next.readyVersion = partial.readyVersion
    if (partial.readyBuildId !== undefined) next.readyBuildId = partial.readyBuildId
    if (partial.latestVersion !== undefined) next.latestVersion = partial.latestVersion
    if (partial.lastCheckedAt !== undefined) next.lastCheckedAt = partial.lastCheckedAt
    if (partial.failure !== undefined) next.failure = partial.failure
    if (partial.dismissedBuildId !== undefined) next.dismissedBuildId = partial.dismissedBuildId
    this.state = next
    this.notify()
  }

  /**
   * Re-entrant: React StrictMode (dev) invokes the owning effect
   * mount->cleanup->mount synchronously before any awaited work here settles,
   * so a stale first invocation must not attach duplicate listeners or leak a
   * second poll timer once a later start() supersedes it. `disposed` resets so
   * the controller keeps working after that synchronous cycle; `startEpoch`
   * lets a superseded invocation detect it lost the race after resuming from
   * an await and bail before touching listeners/timers.
   */
  async start(): Promise<void> {
    this.disposed = false
    const epoch = ++this.startEpoch

    this.unsubscribes.push(this.deps.lifecycle.onOnline(() => void this.check()))
    this.unsubscribes.push(this.deps.lifecycle.onVisible(() => void this.check()))
    this.unsubscribes.push(this.deps.lifecycle.onPageshow((event) => this.handlePageshow(event)))

    if (this.deps.isDev) {
      this.pollTimer = setInterval(() => void this.check(), this.deps.pollIntervalMs)
      return
    }

    // Attached before the registration lookup below so a controllerchange
    // during that async gap is never missed.
    this.serviceWorkerAddEventListener("controllerchange", () => {
      void this.onControllerChange()
    })

    const registration = await this.getRegistration()
    if (this.disposed || epoch !== this.startEpoch) return
    if (registration) {
      this.attachRegistrationListeners(registration)
      await this.observeRegistration(registration)
      if (this.disposed || epoch !== this.startEpoch) return
    }

    this.pollTimer = setInterval(() => void this.check(), this.deps.pollIntervalMs)
    // Drive the first real network check right away instead of waiting for
    // the poll interval to elapse; deferred a tick so it never races the
    // synchronous conclusions start() just drew from local worker state.
    this.startupCheckTimer = setTimeout(() => {
      this.startupCheckTimer = null
      void this.check()
    }, 0)
  }

  dispose(): void {
    this.disposed = true
    // Invalidate any start() continuation still suspended on an await so it
    // cannot resume and attach listeners/timers after this teardown.
    this.startEpoch++
    this.nextGeneration()
    this.checkPromise = null
    this.applyAttempt = null
    this.applyPromise = null
    this.reloadResolve?.()
    this.reloadResolve = null
    this.reloadPromise = null
    this.trackedInstallingWorkers = new WeakSet()
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.startupCheckTimer) {
      clearTimeout(this.startupCheckTimer)
      this.startupCheckTimer = null
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
    this.listeners.clear()
  }

  private serviceWorkerAddEventListener(type: "controllerchange", listener: () => void): void {
    this.deps.serviceWorker?.addEventListener(type, listener)
    this.unsubscribes.push(() => this.deps.serviceWorker?.removeEventListener(type, listener))
  }

  /**
   * Bounded end-to-end: neither `getRegistration()` nor the `ready` fallback
   * is guaranteed to ever settle (no registration ever completing leaves
   * `ready` pending forever), and that must not hang startup, check(), or
   * apply().
   */
  private async getRegistration(): Promise<ServiceWorkerRegistration | null> {
    const sw = this.deps.serviceWorker
    if (!sw) return null
    return raceWithTimeout(this.probeRegistration(sw), APP_UPDATE_REGISTRATION_TIMEOUT_MS, null)
  }

  private async probeRegistration(sw: ServiceWorkerContainer): Promise<ServiceWorkerRegistration | null> {
    const fromGet = await safeAsync(() => sw.getRegistration(), null)
    if (fromGet) return fromGet
    return safeAsync(() => sw.ready, null)
  }

  private attachRegistrationListeners(registration: ServiceWorkerRegistration): void {
    const onUpdateFound = () => this.onUpdateFound(registration)
    registration.addEventListener("updatefound", onUpdateFound)
    this.unsubscribes.push(() => registration.removeEventListener("updatefound", onUpdateFound))
  }

  private async observeRegistration(registration: ServiceWorkerRegistration): Promise<void> {
    const generation = this.nextGeneration()

    if (registration.waiting) {
      const status = await this.queryWorkerStatus(registration.waiting)
      if (status) {
        this.publishReadyIfNewer(status, generation)
        return
      }
    }
    const installing = registration.installing
    if (installing) {
      // An installing worker already in a terminal state resolves as part of
      // this same startup observation (using this same generation) instead of
      // being handed to the fire-and-forget tracker — only a genuinely
      // still-installing worker needs that (see trackInstallingWorker: no
      // time bound on a valid, ongoing download).
      if (installing.state === "installed" || installing.state === "activated") {
        const target = registration.waiting ?? installing
        const status = await this.queryWorkerStatus(target)
        if (status) this.publishReadyIfNewer(status, generation)
        return
      }
      if (installing.state === "redundant") {
        this.setState({
          phase: "failed",
          failure: "download-failed",
          readyVersion: null,
          readyBuildId: null,
          _generation: generation,
        })
        return
      }
      this.setState({ phase: "downloading", failure: null, _generation: generation })
      this.trackInstallingWorker(installing, registration)
      return
    }
    if (this.deps.serviceWorker?.controller) {
      const status = await this.queryWorkerStatus(this.deps.serviceWorker.controller)
      if (status) this.publishReadyIfNewer(status, generation)
    }
  }

  private onUpdateFound(registration: ServiceWorkerRegistration): void {
    const installing = registration.installing
    if (!installing) return
    if (this.applyPromise) return
    const generation = this.nextGeneration()
    this.setState({ phase: "downloading", failure: null, _generation: generation })
    this.trackInstallingWorker(installing, registration)
  }

  /**
   * Persistent, disposal-bound tracking of one installing worker through to a
   * terminal state (installed/activated -> ready, redundant -> failed).
   * Idempotent per worker instance. No time bound on a valid install: a slow
   * but ongoing download must not be failed just for taking a while — only the
   * browser's own `redundant` signal (or dispose()) ends this early.
   */
  private trackInstallingWorker(worker: ServiceWorker, registration: ServiceWorkerRegistration): void {
    if (this.trackedInstallingWorkers.has(worker)) return
    this.trackedInstallingWorkers.add(worker)

    const settle = async () => {
      worker.removeEventListener("statechange", onStateChange)
      if (this.disposed) return
      if (this.applyPromise) return
      if (registration.installing && registration.installing !== worker) return
      if (registration.waiting && registration.waiting !== worker) return
      const generation = this.nextGeneration()
      if (worker.state === "redundant") {
        this.setState({
          phase: "failed",
          failure: "download-failed",
          readyVersion: null,
          readyBuildId: null,
          _generation: generation,
        })
        return
      }
      const target = registration.waiting ?? worker
      const status = await this.queryWorkerStatus(target)
      if (this.disposed || this.applyPromise) return
      if (status) this.publishReadyIfNewer(status, generation)
    }

    const onStateChange = () => {
      if (worker.state === "installed" || worker.state === "activated" || worker.state === "redundant") {
        void settle()
      }
    }

    if (worker.state === "installed" || worker.state === "activated" || worker.state === "redundant") {
      void settle()
      return
    }
    worker.addEventListener("statechange", onStateChange)
    this.unsubscribes.push(() => worker.removeEventListener("statechange", onStateChange))
  }

  /** Reports a genuinely newer local build as ready. Never claims "current" — that is check()'s job, gated on an actual server probe (see doCheck). */
  private publishReadyIfNewer(status: WorkerStatusReply, generation: number): void {
    if (this.applyPromise) return
    if (status.buildId === this.deps.buildInfo.buildId) return
    this.setState({
      phase: "ready",
      readyVersion: status.version,
      readyBuildId: status.buildId,
      failure: null,
      _generation: generation,
    })
  }

  private async onControllerChange(): Promise<void> {
    const controllerAtStart = this.deps.serviceWorker?.controller
    if (!controllerAtStart) return
    const generation = this.applyPromise ? this.generation : this.nextGeneration()
    const attempt = this.applyAttempt

    const status = await this.queryWorkerStatus(controllerAtStart)
    if (!status) return
    // Re-verify identity right before acting: the controller — and the reply
    // we just got about it — can be stale by the time this async gap closes.
    if (this.deps.serviceWorker?.controller !== controllerAtStart) return

    if (
      attempt &&
      this.applyAttempt === attempt &&
      status.buildId === attempt.buildId &&
      controllerAtStart.state === "activated"
    ) {
      void this.requestReload()
      return
    }
    if (this.applyPromise) return
    this.publishReadyIfNewer(status, generation)
  }

  /**
   * Record that the user dismissed the notice for a specific build id. Pins
   * the id the caller passed, not whatever the worker currently reports —
   * dismissing a notice for a build that has since been superseded must not
   * silently dismiss the new one. Never cleared by ordinary state
   * observations; a differing future readyBuildId naturally reannounces.
   */
  dismissNotice(buildId: string): void {
    this.setState({ dismissedBuildId: buildId })
  }

  async check(): Promise<void> {
    if (this.deps.isDev) {
      this.setState({ phase: "current", latestVersion: null, lastCheckedAt: new Date() })
      return
    }
    if (this.disposed || this.state.phase === "applying") return
    if (this.checkPromise) return this.checkPromise
    const pending = this.doCheck()
    this.checkPromise = pending
    try {
      await pending
    } finally {
      if (this.checkPromise === pending) this.checkPromise = null
      if (!this.disposed && !this.applyPromise) {
        try {
          this.deps.serviceWorker?.controller?.postMessage({ type: SW_MSG_RUN_GC })
        } catch {
          // A replaced worker may reject the cleanup request. A later check retries it.
        }
      }
    }
  }

  private async doCheck(): Promise<void> {
    if (this.state.phase === "applying") return
    const generation = this.nextGeneration()
    this.setState({ phase: "checking", failure: null, _generation: generation })

    const registration = await this.getRegistration()
    if (this.applyPromise) return

    if (!registration) {
      const online = navigator.onLine
      this.setState({
        phase: online ? "unavailable" : "offline",
        readyVersion: null,
        readyBuildId: null,
        latestVersion: null,
        lastCheckedAt: new Date(),
        failure: online ? "check-failed" : null,
        _generation: generation,
      })
      return
    }

    const latestPromise = safeAsync(() => this.deps.fetchLatestVersion(), null)
    const updateOkPromise = safeAsync(async () => {
      await registration.update()
      return true
    }, false)
    const updateOk = await raceWithTimeout(updateOkPromise, APP_UPDATE_CHECK_TIMEOUT_MS, false)
    if (this.applyPromise) return

    let readyStatus: WorkerStatusReply | null = null

    if (registration.waiting) {
      readyStatus = await this.queryWorkerStatus(registration.waiting)
    }

    if (!readyStatus && registration.installing) {
      // Do not block here waiting for the install to finish (it may
      // legitimately take a while) — report "downloading" and let the
      // persistent updatefound/statechange tracking resolve it later.
      this.trackInstallingWorker(registration.installing, registration)
      this.setState({ phase: "downloading", failure: null, lastCheckedAt: new Date(), _generation: generation })
      return
    }

    if (!readyStatus && this.deps.serviceWorker?.controller) {
      readyStatus = await this.queryWorkerStatus(this.deps.serviceWorker.controller)
    }
    if (!readyStatus && registration.active && !this.deps.serviceWorker?.controller) {
      readyStatus = await this.queryWorkerStatus(registration.active)
    }

    const latest = await raceWithTimeout(latestPromise, APP_UPDATE_CHECK_TIMEOUT_MS, null)
    if (this.applyPromise) return

    // A genuinely newer local build takes priority over anything the server
    // probe says — online or off, probe success or failure.
    if (readyStatus && readyStatus.buildId !== this.deps.buildInfo.buildId) {
      this.setState({
        phase: "ready",
        readyVersion: readyStatus.version,
        readyBuildId: readyStatus.buildId,
        latestVersion: latest,
        lastCheckedAt: new Date(),
        failure: null,
        _generation: generation,
      })
      return
    }

    // No locally-ready newer build. "current" is truthful only when the
    // server probe actually confirms this build is the latest one — a
    // controller that merely matches our own running build proves nothing
    // about the server (it's true before any check ever runs).
    if (updateOk && latest && latest === this.deps.buildInfo.version) {
      this.setState({
        phase: "current",
        readyVersion: null,
        readyBuildId: null,
        latestVersion: latest,
        lastCheckedAt: new Date(),
        failure: null,
        _generation: generation,
      })
      return
    }

    const online = navigator.onLine
    this.setState({
      phase: online ? "unavailable" : "offline",
      readyVersion: null,
      readyBuildId: null,
      latestVersion: latest,
      lastCheckedAt: new Date(),
      failure: !updateOk && online ? "check-failed" : null,
      _generation: generation,
    })
  }

  async apply(): Promise<void> {
    const targetBuildId = this.state.readyBuildId
    if (!targetBuildId) {
      this.setState({ phase: "failed", failure: "activation-failed", _generation: this.nextGeneration() })
      return
    }
    if (this.applyPromise) return this.applyPromise

    const generation = this.nextGeneration()
    this.setState({ phase: "applying", failure: null, _generation: generation })
    const attempt: ApplyAttempt = { buildId: targetBuildId, startedAt: Date.now() }
    this.applyAttempt = attempt
    this.applyPromise = this.doApply(targetBuildId, generation, attempt).finally(() => {
      // Only the attempt that owns these fields may clear them — a forced
      // reset (bfcache pageshow) or a superseding retry may have already
      // moved on by the time this settles.
      if (this.applyAttempt === attempt) {
        this.applyAttempt = null
        this.applyPromise = null
      }
    })
    return this.applyPromise
  }

  private async doApply(targetBuildId: string, generation: number, attempt: ApplyAttempt): Promise<void> {
    const superseded = () => this.applyAttempt !== attempt

    const registration = await this.getRegistration()
    if (superseded()) return
    if (!registration) {
      await this.failApply(null, generation, "activation-failed")
      return
    }

    const targetWorker = await this.findWorkerWithBuildId(registration, targetBuildId)
    if (superseded()) return
    if (!targetWorker) {
      const controller = this.deps.serviceWorker?.controller
      const status = controller ? await this.queryWorkerStatus(controller) : null
      if (superseded()) return
      if (
        status &&
        status.buildId === targetBuildId &&
        controller?.state === "activated" &&
        this.deps.serviceWorker?.controller === controller
      ) {
        // The target is already the active controller (e.g. activated via
        // skipWaiting from another tab) — just confirm the navigation.
        return this.requestReload()
      }
      await this.failApply(registration, generation, "activation-failed")
      return
    }

    try {
      targetWorker.postMessage({ type: SW_MSG_APPLY_UPDATE, buildId: targetBuildId })
    } catch {
      await this.failApply(registration, generation, "activation-failed")
      return
    }

    const deadline = Date.now() + APP_UPDATE_APPLY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.reloadPromise) return this.reloadPromise
      if (superseded()) return
      const controller = this.deps.serviceWorker?.controller
      if (controller?.state === "activated") {
        const status = await this.queryWorkerStatus(controller)
        if (superseded()) return
        // Re-verify identity immediately before deciding to reload: the
        // controller can have moved on again during that round trip.
        if (status && this.deps.serviceWorker?.controller === controller && status.buildId === targetBuildId) {
          return this.requestReload()
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    if (this.reloadPromise) return this.reloadPromise
    if (superseded()) return
    await this.failApply(registration, generation, "activation-timeout")
  }

  private async failApply(
    registration: ServiceWorkerRegistration | null,
    generation: number,
    failure: AppUpdateFailure
  ): Promise<void> {
    const candidate = registration?.waiting ?? this.deps.serviceWorker?.controller
    const status = candidate ? await this.queryWorkerStatus(candidate) : null
    const stillAvailable =
      candidate && (registration?.waiting === candidate || this.deps.serviceWorker?.controller === candidate)
    const ready = stillAvailable && status?.buildId !== this.deps.buildInfo.buildId ? status : null
    this.setState({
      phase: "failed",
      failure,
      readyBuildId: ready?.buildId ?? null,
      readyVersion: ready?.version ?? null,
      _generation: generation,
    })
  }

  /**
   * Single-flight reload request. Stays pending until either the navigation
   * actually happens (this JS context is torn down and the timer below never
   * fires — the common case) or the confirm timeout proves it was blocked or
   * cancelled, at which point the failure is surfaced and the guards reset so
   * a retry can call reload() again.
   */
  private requestReload(): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise
    const pending = new Promise<void>((resolve) => {
      this.reloadResolve = resolve
      this.reloadTimer = setTimeout(() => this.failReload(), APP_UPDATE_RELOAD_CONFIRM_TIMEOUT_MS)
    })
    this.reloadPromise = pending
    try {
      this.deps.reload()
    } catch {
      this.failReload()
    }
    return pending
  }

  private failReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
    const resolve = this.reloadResolve
    this.reloadResolve = null
    this.reloadPromise = null
    this.applyPromise = null
    this.applyAttempt = null
    const generation = this.nextGeneration()
    this.setState({
      phase: "failed",
      failure: "activation-timeout",
      readyBuildId: null,
      readyVersion: null,
      _generation: generation,
    })
    void this.failApply(null, generation, "activation-timeout")
    resolve?.()
  }

  private async findWorkerWithBuildId(
    registration: ServiceWorkerRegistration,
    buildId: string
  ): Promise<ServiceWorker | null> {
    const candidates = [registration.waiting, registration.installing, registration.active]
    for (const candidate of candidates) {
      if (!candidate) continue
      const status = await this.queryWorkerStatus(candidate)
      if (status && status.buildId === buildId) return candidate
    }
    return null
  }

  /**
   * The one boundary that turns a raw worker reply into a usable status: it
   * resolves non-null ONLY for a well-formed `ready: true` reply with
   * non-empty version/buildId — every caller can trust a non-null result
   * outright instead of re-checking `.ready`. Both ports are always closed and
   * the timer always cleared, on every resolution path, including a
   * synchronous throw from `postMessage` itself (a terminated worker can throw
   * rather than reject, which would otherwise escape as an unhandled
   * rejection and strand the caller — apply() in particular — mid-operation).
   */
  private async queryWorkerStatus(worker: ServiceWorker): Promise<WorkerStatusReply | null> {
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      let settled = false
      const finish = (result: WorkerStatusReply | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        channel.port1.onmessage = null
        channel.port1.close()
        channel.port2.close()
        resolve(result)
      }
      const timer = setTimeout(() => finish(null), APP_UPDATE_STATUS_TIMEOUT_MS)
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data as Partial<WorkerStatusReply> | undefined
        if (
          data?.type !== SW_MSG_STATUS_REPLY ||
          data.ready !== true ||
          typeof data.version !== "string" ||
          typeof data.buildId !== "string" ||
          data.version.length === 0 ||
          data.buildId.length === 0
        ) {
          finish(null)
          return
        }
        finish({ type: SW_MSG_STATUS_REPLY, version: data.version, buildId: data.buildId, ready: true })
      }
      try {
        worker.postMessage({ type: SW_MSG_QUERY_STATUS }, [channel.port2])
      } catch {
        finish(null)
      }
    })
  }

  private handlePageshow(event: PageTransitionEvent): void {
    if (!event.persisted) {
      return
    }
    // A bfcache restore proves this document is alive again — a reload we
    // requested cannot have actually happened. Fail it now instead of
    // waiting out the confirm timer, so apply() unblocks and a retry works.
    // Either forced-failure branch returns without checking: check() would
    // otherwise immediately (synchronously) overwrite the "failed" state it
    // just set.
    if (this.reloadPromise) {
      this.failReload()
      return
    }
    if (this.state.phase === "applying" && this.applyAttempt) {
      const age = Date.now() - this.applyAttempt.startedAt
      if (age > APP_UPDATE_APPLYING_MAX_AGE_MS) {
        this.failReload()
        return
      }
    }
    void this.check()
  }
}

export function createBrowserAppUpdateController(pollIntervalMs: number): AppUpdateController {
  return new AppUpdateController({
    serviceWorker: navigator.serviceWorker,
    fetchLatestVersion,
    buildInfo: { version: currentAppVersion(), buildId: currentAppBuildId() },
    isDev: import.meta.env.DEV,
    pollIntervalMs,
    lifecycle: createBrowserAppUpdateLifecycle(),
    reload: () => window.location.reload(),
  })
}

/**
 * Recover only on a CONFIRMED stale build: both versions known and different.
 * The recovery this gates today is a plain reload (see `runSwRecovery` in
 * sw-recovery.ts) — an unknown probe result (offline, fetch failed) must not
 * trigger it.
 */
export function shouldRecoverForVersion(current: string | null, latest: string | null): boolean {
  return Boolean(current && latest && current !== latest)
}

/**
 * The latest deployed build version from the server, or null if it can't be
 * read. The single implementation — `createBrowserAppUpdateController` reuses
 * this rather than duplicating the fetch.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("/version.json", {
      cache: "no-store",
      signal: AbortSignal.timeout(APP_UPDATE_CHECK_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === "string" ? body.version : null
  } catch {
    return null
  }
}
