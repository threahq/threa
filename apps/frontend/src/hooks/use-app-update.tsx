import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { AppUpdateController, AppUpdateState, createBrowserAppUpdateController } from "@/lib/app-update"
import { currentAppBuildId } from "@/lib/app-build"
import { SW_MSG_BUILD_REPLY, SW_MSG_QUERY_BUILD } from "@/lib/sw-messages"

export { currentAppBuiltAt, currentAppInstalledAt, currentAppVersion, currentAppBuildId } from "@/lib/app-build"
export { fetchLatestVersion, shouldRecoverForVersion } from "@/lib/app-update"
export type { AppUpdateState }

export const APP_UPDATE_POLL_INTERVAL_MS = 300_000

const AppUpdateContext = createContext<AppUpdateController | null>(null)

interface AppUpdateProviderProps {
  children: ReactNode
  /**
   * Optional controller for real-boundary tests. When omitted, a browser-bound
   * controller is constructed once at provider mount and disposed on unmount.
   */
  controller?: AppUpdateController
}

export function AppUpdateProvider({ children, controller: propController }: AppUpdateProviderProps) {
  const [controller] = useState(() => propController ?? createBrowserAppUpdateController(APP_UPDATE_POLL_INTERVAL_MS))

  useEffect(() => {
    void controller.start()
    const sw = navigator.serviceWorker
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string } | undefined
      if (data?.type === SW_MSG_QUERY_BUILD) {
        // The SW transfers a MessageChannel port so the reply reaches the
        // waiting GC handler; fall back to event.source for older protocols.
        const replyPort = event.ports?.[0]
        const reply = { type: SW_MSG_BUILD_REPLY, buildId: currentAppBuildId() ?? "" }
        if (replyPort) {
          replyPort.postMessage(reply)
        } else {
          ;(event.source as ServiceWorker | MessagePort | null)?.postMessage(reply)
        }
      }
    }
    sw?.addEventListener("message", onMessage)
    return () => {
      controller.dispose()
      sw?.removeEventListener("message", onMessage)
    }
  }, [controller])

  return <AppUpdateContext.Provider value={controller}>{children}</AppUpdateContext.Provider>
}

export function useAppUpdate(): AppUpdateState & {
  check: () => Promise<void>
  apply: () => Promise<void>
  dismissNotice: (buildId: string) => void
} {
  const controller = useContext(AppUpdateContext)
  if (!controller) {
    throw new Error("useAppUpdate must be used within AppUpdateProvider")
  }
  // Explicit shared snapshot: getState() returns the same object reference
  // until setState actually changes something, so this never over-renders.
  // check/apply/dismissNotice are bound once in the controller's constructor,
  // so handing them out directly keeps stable identities without an effect.
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  return {
    ...state,
    check: controller.check,
    apply: controller.apply,
    dismissNotice: controller.dismissNotice,
  }
}

export function useIsServiceWorkerControlled(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const serviceWorker = navigator.serviceWorker
      if (!serviceWorker) return () => {}
      serviceWorker.addEventListener("controllerchange", notify)
      return () => serviceWorker.removeEventListener("controllerchange", notify)
    },
    () => Boolean(navigator.serviceWorker?.controller),
    () => false
  )
}
