import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from "react"
import { io, Socket } from "socket.io-client"
import { HEARTBEAT_INTERACTION_THROTTLE_MS } from "@threa/types"
import { api } from "@/api/client"
import { getCachedWsConfig, setCachedWsConfig } from "@/lib/cached-ws-config"
import { usePageActivity } from "@/hooks/use-page-activity"
import { usePageInteraction } from "@/hooks/use-page-interaction"
import { useSwPresence } from "@/hooks/use-sw-presence"

/** Periodic heartbeat tick for session liveness — must be < ACTIVE_SESSION_WINDOW_MS on the backend (60s). */
const PERIODIC_HEARTBEAT_INTERVAL_MS = 30_000

/** Throttle for focus-change-driven heartbeats so a flicker of blur/focus events doesn't flood the socket. */
const FOCUS_CHANGE_HEARTBEAT_THROTTLE_MS = 10_000

/**
 * Socket connection status.
 * - "disconnected": No connection (initial state or after reconnect failure)
 * - "connecting": Attempting initial connection
 * - "connected": Successfully connected
 * - "reconnecting": Was connected, now attempting to reconnect
 */
export type SocketStatus = "disconnected" | "connecting" | "connected" | "reconnecting"

interface SocketContextValue {
  socket: Socket | null
  /** Current connection status */
  status: SocketStatus
  /** Counter that increments on each reconnection (use in useEffect deps to trigger re-bootstrap) */
  reconnectCount: number
}

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  status: "disconnected",
  reconnectCount: 0,
})

interface WorkspaceConfig {
  region: string
  wsUrl: string
}

interface SocketProviderProps {
  workspaceId: string
  children: ReactNode
}

export function SocketProvider({ workspaceId, children }: SocketProviderProps) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [status, setStatus] = useState<SocketStatus>("connecting")
  const [reconnectCount, setReconnectCount] = useState(0)
  const pageActivity = usePageActivity()
  const pageInteraction = usePageInteraction()

  // Track if we've ever been connected (to distinguish initial connect from reconnect)
  const hasEverConnectedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let activeSocket: Socket | null = null
    // Raw (pre-dev-rewrite) wsUrl the active socket was built from, so a
    // background revalidation can tell whether it actually moved.
    let activeWsUrl: string | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    function buildSocket(config: WorkspaceConfig): Socket {
      // In dev, the router returns ws://localhost:PORT but we may be accessing
      // from a different host (e.g. phone over WiFi). Rewrite to match the actual host.
      const wsUrl = import.meta.env.DEV ? config.wsUrl.replace("localhost", window.location.hostname) : config.wsUrl

      const s = io(wsUrl, {
        path: "/socket.io/",
        // Prefer a direct WebSocket so the socket skips Engine.IO's HTTP
        // long-polling handshake (several round-trips before it upgrades). On a
        // cold boot the workspace/stream bootstrap is gated on the socket
        // connecting (SyncEngine.onConnect → subscribe-then-fetch), so a faster
        // connect directly shortens time-to-fresh-data. Polling stays as a
        // fallback for networks that block raw WebSocket.
        transports: ["websocket", "polling"],
        withCredentials: true,
        autoConnect: true,
      })

      // Only the socket that is still the active instance may drive provider
      // state. A socket that was superseded (wsUrl moved → start() built a
      // replacement) or torn down (workspace change) still emits a
      // close-disconnect; without this guard that stale instance would
      // backfire status/reconnectCount onto the socket that replaced it.
      const isStale = () => cancelled || activeSocket !== s

      s.on("connect", () => {
        if (isStale()) return
        const wasReconnecting = hasEverConnectedRef.current
        hasEverConnectedRef.current = true
        setStatus("connected")

        if (wasReconnecting) {
          setReconnectCount((c) => c + 1)
          console.log("[Socket] Reconnected successfully")
        } else {
          console.log("[Socket] Connected to", config.region)
        }
      })

      s.on("disconnect", (reason) => {
        if (isStale()) return
        if (hasEverConnectedRef.current) {
          setStatus("reconnecting")
          console.log("[Socket] Disconnected:", reason)
        } else {
          setStatus("disconnected")
        }
      })

      s.on("error", (error: { message: string }) => {
        if (isStale()) return
        console.error("[Socket] Error:", error.message)
      })

      // Socket.io manager events for reconnection tracking
      s.io.on("reconnect_attempt", (socketAttempt) => {
        if (isStale()) return
        setStatus("reconnecting")
        console.log(`[Socket] Reconnect attempt ${socketAttempt}`)
      })

      s.io.on("reconnect_error", (error) => {
        if (isStale()) return
        console.error("[Socket] Reconnect error:", error.message)
      })

      s.io.on("reconnect_failed", () => {
        if (isStale()) return
        console.error("[Socket] Reconnect failed - giving up")
        setStatus("disconnected")
      })

      return s
    }

    function start(config: WorkspaceConfig) {
      // Swap the active ref to the replacement before closing the previous
      // socket, so the previous socket's synchronous close-disconnect is
      // rejected by isStale() instead of clobbering the new socket's status.
      const previous = activeSocket
      activeSocket = buildSocket(config)
      activeWsUrl = config.wsUrl
      previous?.close()
      setSocket(activeSocket)
    }

    async function fetchConfig(attempt = 0) {
      try {
        const config = await api.get<WorkspaceConfig>(`/api/workspaces/${workspaceId}/config`)
        if (cancelled) return
        setCachedWsConfig(workspaceId, config)

        // Cold boot (no cache) ⇒ connect now. Warm boot ⇒ only swap if the
        // (effectively immutable) URL actually moved; otherwise keep the
        // socket that already connected from cache — no needless reconnect.
        if (!activeSocket || config.wsUrl !== activeWsUrl) {
          start(config)
        }
      } catch (error) {
        console.error("[Socket] Failed to fetch workspace config:", error)
        if (cancelled) return

        // A warm boot already has a working socket from the cached config — a
        // failed background revalidation is harmless, so don't churn status or
        // burn retries; the socket's own reconnection logic handles drops.
        if (activeSocket) return

        // Cold boot: retry with exponential backoff (1s, 2s, 4s, then give up)
        if (attempt < 3) {
          const delay = 1000 * Math.pow(2, attempt)
          console.log(`[Socket] Retrying config fetch in ${delay}ms (attempt ${attempt + 1}/3)`)
          setStatus("reconnecting")
          retryTimer = setTimeout(() => {
            if (!cancelled) fetchConfig(attempt + 1)
          }, delay)
        } else {
          console.error("[Socket] Config fetch failed after 3 retries — giving up")
          setStatus("disconnected")
        }
      }
    }

    // The region/wsUrl is assigned at workspace creation and effectively
    // immutable, so a cached value lets the socket connect with zero round
    // trip on a returning launch. The fetch still runs to revalidate.
    const cached = getCachedWsConfig(workspaceId)
    if (cached) {
      start(cached)
    }
    fetchConfig()

    return () => {
      cancelled = true
      hasEverConnectedRef.current = false
      if (retryTimer) clearTimeout(retryTimer)
      activeSocket?.close()
      setSocket(null)
      setStatus("connecting")
      setReconnectCount(0)
    }
  }, [workspaceId])

  // Heartbeat for push notification session tracking. Sends { focused, interacted }
  // so the backend can pick the device the user is actually on (focused window
  // with a recent interaction) and avoid pushing to background PWAs.
  const focusChangeThrottleRef = useRef(0)
  const interactionThrottleRef = useRef(0)
  const lastSentInteractionAtRef = useRef(0)
  const previousPageActivityRef = useRef(pageActivity)
  const pageFocusedRef = useRef(pageActivity.isFocused)
  pageFocusedRef.current = pageActivity.isFocused

  useEffect(() => {
    if (!socket || status !== "connected") return

    const emitHeartbeat = () => {
      const lastInteractionAt = pageInteraction.getLastInteractionAt()
      const interacted = lastInteractionAt > lastSentInteractionAtRef.current
      if (interacted) lastSentInteractionAtRef.current = lastInteractionAt
      socket.emit("heartbeat", { focused: pageFocusedRef.current, interacted })
    }

    // Emit immediately so the backend knows this tab is active right away
    emitHeartbeat()
    const heartbeatInterval = setInterval(emitHeartbeat, PERIODIC_HEARTBEAT_INTERVAL_MS)

    // Fire an immediate heartbeat on the first interaction after a quiet
    // stretch so the backend learns about renewed activity within seconds,
    // not up to 30s.
    const unsubscribe = pageInteraction.subscribe(() => {
      const now = Date.now()
      if (now - interactionThrottleRef.current < HEARTBEAT_INTERACTION_THROTTLE_MS) return
      interactionThrottleRef.current = now
      emitHeartbeat()
    })

    return () => {
      clearInterval(heartbeatInterval)
      unsubscribe()
    }
  }, [socket, status, pageInteraction])

  // Record recent interaction so the SW can gate push suppression on activity,
  // not focus alone (see useSwPresence). Reuses the tracker the heartbeats use.
  useSwPresence(pageInteraction)

  useEffect(() => {
    const previousPageActivity = previousPageActivityRef.current
    const gainedFocus = !previousPageActivity.isFocused && pageActivity.isFocused
    const becameVisible = !previousPageActivity.isVisible && pageActivity.isVisible

    if (!socket || status !== "connected") {
      previousPageActivityRef.current = pageActivity
      return
    }

    previousPageActivityRef.current = pageActivity

    if (!gainedFocus && !becameVisible) return

    // Focus gains bypass the throttle so a becameVisible heartbeat
    // (focused=false) doesn't block the closely-following gainedFocus heartbeat.
    const now = Date.now()
    if (gainedFocus || now - focusChangeThrottleRef.current > FOCUS_CHANGE_HEARTBEAT_THROTTLE_MS) {
      focusChangeThrottleRef.current = now
      socket.emit("heartbeat", { focused: pageActivity.isFocused, interacted: false })
    }
  }, [socket, status, pageActivity])

  return <SocketContext.Provider value={{ socket, status, reconnectCount }}>{children}</SocketContext.Provider>
}

export function useSocket(): Socket | null {
  return useContext(SocketContext).socket
}

export function useSocketStatus(): SocketStatus {
  return useContext(SocketContext).status
}

export function useSocketConnected(): boolean {
  return useContext(SocketContext).status === "connected"
}

export function useSocketReconnectCount(): number {
  return useContext(SocketContext).reconnectCount
}

export function useSocketIsReconnecting(): boolean {
  return useContext(SocketContext).status === "reconnecting"
}
