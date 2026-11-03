import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useAccountScopeOptional } from "@/auth/account-scope"
import { useCoordinatedLoading, useSocketStatus } from "@/contexts"
import { usePageActivity } from "@/hooks/use-page-activity"
import { WifiOff, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

const UNSTABLE_STATE_DELAY_MS = 3000

export function useIsOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb)
      window.addEventListener("offline", cb)
      return () => {
        window.removeEventListener("online", cb)
        window.removeEventListener("offline", cb)
      }
    },
    () => navigator.onLine
  )
}

type ConnectionState = "connected" | "connecting" | "offline" | "reconnecting" | "disconnected" | "storage"

/** SQLite holds this account's primary copy but nothing serves it right now; its requests wait for the next owner. */
function useStorageReconnecting(): boolean {
  const db = useAccountScopeOptional()?.getDb() ?? null
  const subscribe = useCallback((listener: () => void) => db?.onStorageReconnecting(listener) ?? (() => {}), [db])
  return useSyncExternalStore(subscribe, () => db?.storageReconnecting ?? false)
}

export function useConnectionState(): ConnectionState {
  const socketStatus = useSocketStatus()
  const isOnline = useIsOnline()
  const storageReconnecting = useStorageReconnecting()

  const socketStable = socketStatus === "connected" || socketStatus === "connecting"
  if (socketStable && storageReconnecting) return "storage"
  if (socketStatus === "connected") return "connected"
  if (socketStatus === "connecting") return "connecting"
  if (!isOnline) return "offline"
  if (socketStatus === "reconnecting") return "reconnecting"
  return "disconnected"
}

function useUnstableConnectionVisible(state: ConnectionState): boolean {
  const isStable = state === "connected" || state === "connecting"
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (isStable) {
      setVisible(false)
      return
    }
    const id = window.setTimeout(() => setVisible(true), UNSTABLE_STATE_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [isStable])
  return visible
}

/**
 * Floating pill that overlays the content area when not connected.
 * Uses absolute positioning so it never affects layout or pushes
 * content under the mobile keyboard.
 */
export function ConnectionStatus() {
  const phase = useCoordinatedLoading((loading) => loading.phase)
  const state = useConnectionState()
  const showPill = useUnstableConnectionVisible(state)
  const pageActivity = usePageActivity()

  if (phase !== "ready" || !pageActivity.isVisible || !showPill) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-2">
      <div
        className={cn(
          "pointer-events-auto",
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1",
          "text-[11px] font-medium tracking-wide",
          "shadow-sm backdrop-blur-md",
          "animate-in fade-in slide-in-from-top-2 duration-200",
          state === "offline" && "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20",
          (state === "reconnecting" || state === "storage") && "bg-muted/80 text-muted-foreground ring-1 ring-border",
          state === "disconnected" && "bg-destructive/10 text-destructive ring-1 ring-destructive/20"
        )}
      >
        {state === "reconnecting" || state === "storage" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <WifiOff className="h-3 w-3" />
        )}
        <span>
          {state === "offline" && "Offline"}
          {state === "reconnecting" && "Reconnecting"}
          {state === "disconnected" && "Disconnected"}
          {state === "storage" && "Storage reconnecting"}
        </span>
      </div>
    </div>
  )
}
