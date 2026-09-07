import type { AppUpdateController, AppUpdateState } from "@/lib/app-update"

/**
 * Drives `AppUpdateProvider` through its `controller` prop so update surfaces can
 * be exercised in every phase the coordinator produces. `apply()` sets `applying`
 * before it awaits, matching the coordinator's single-flight contract — that is
 * what makes a click busy on the same tick.
 *
 * This is a phase driver, not a lifecycle model: it never touches a service
 * worker, so it proves what the UI renders and requests, never that the
 * coordinator or worker behave that way. The lifecycle itself is proven against
 * a real worker in `tests/app-update/`.
 */

/** The controller surface `AppUpdateProvider` and `useAppUpdate` actually use. */
type ControllerContract = Pick<
  AppUpdateController,
  "getState" | "subscribe" | "start" | "dispose" | "check" | "apply" | "dismissNotice"
>

const INITIAL: AppUpdateState = {
  phase: "idle",
  readyVersion: null,
  readyBuildId: null,
  latestVersion: null,
  lastCheckedAt: null,
  failure: null,
  dismissedBuildId: null,
}

export class TestAppUpdateController implements ControllerContract {
  private listeners = new Set<() => void>()
  private snapshot: AppUpdateState
  checkCalls = 0
  applyCalls = 0

  constructor(initial: Partial<AppUpdateState> = {}) {
    this.snapshot = { ...INITIAL, ...initial }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): AppUpdateState => this.snapshot

  start = async (): Promise<void> => {}

  dispose = (): void => {}

  check = (): Promise<void> => {
    this.checkCalls += 1
    this.emit({ phase: "checking" })
    return new Promise(() => {})
  }

  apply = (): Promise<void> => {
    this.applyCalls += 1
    this.emit({ phase: "applying", failure: null })
    return new Promise(() => {})
  }

  dismissNotice = (buildId: string): void => {
    this.emit({ dismissedBuildId: buildId })
  }

  emit(partial: Partial<AppUpdateState>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }
}

/** The prop type is a class, so nominal; `ControllerContract` above is what
 * actually holds this fake to the real API — the cast only gets it through. */
export function asAppUpdateController(controller: TestAppUpdateController): AppUpdateController {
  return controller as unknown as AppUpdateController
}
