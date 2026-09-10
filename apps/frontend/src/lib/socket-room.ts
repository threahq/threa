import type { Socket } from "socket.io-client"
import { debugBootstrap } from "./bootstrap-debug"
import {
  beginConnectivityObservation,
  categorizeRoom,
  getSocketDiagnosticContext,
  type ConnectivityObservation,
} from "./connectivity-diagnostics/facade"

interface JoinAckResult {
  ok: boolean
  error?: string
}

interface JoinRoomOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_JOIN_TIMEOUT_MS = 5000
const JOIN_FAILURE_REASON = Symbol("joinFailureReason")
type JoinFailureReason = "abort" | "timeout" | "disconnect"
type JoinFailure = Error & { [JOIN_FAILURE_REASON]?: JoinFailureReason }
const pendingJoinsBySocket = new WeakMap<Socket, Map<string, Promise<void>>>()

function joinFailure(message: string, reason: JoinFailureReason): Error {
  const error: JoinFailure = new Error(message)
  error[JOIN_FAILURE_REASON] = reason
  return error
}

function joinFailureReason(error: unknown): JoinFailureReason | undefined {
  return error instanceof Error ? (error as JoinFailure)[JOIN_FAILURE_REASON] : undefined
}

function getPendingJoins(socket: Socket): Map<string, Promise<void>> {
  const pending = pendingJoinsBySocket.get(socket)
  if (pending) return pending

  const next = new Map<string, Promise<void>>()
  pendingJoinsBySocket.set(socket, next)
  return next
}

function waitForConnection(
  socket: Socket,
  room: string,
  timeoutMs: number,
  observation: ConnectivityObservation,
  signal?: AbortSignal
): Promise<void> {
  if (socket.connected) {
    debugBootstrap("Socket already connected before join", { room })
    return Promise.resolve()
  }

  if (signal?.aborted) {
    return Promise.reject(joinFailure(`Join aborted for room "${room}"`, "abort"))
  }

  observation.record("room_join_connection_wait")
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let lastConnectError: string | null = null

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      socket.off("connect", handleConnect)
      socket.off("connect_error", handleConnectError)
      signal?.removeEventListener("abort", handleAbort)
    }

    const handleConnect = () => {
      cleanup()
      debugBootstrap("Socket connected while waiting to join room", { room })
      resolve()
    }

    const handleConnectError = (error: Error) => {
      lastConnectError = error.message
    }

    const handleAbort = () => {
      cleanup()
      reject(joinFailure(`Join aborted for room "${room}"`, "abort"))
    }

    socket.on("connect", handleConnect)
    socket.on("connect_error", handleConnectError)
    signal?.addEventListener("abort", handleAbort, { once: true })

    // Handle race where socket connected between initial check and listener registration.
    if (socket.connected) {
      cleanup()
      resolve()
      return
    }

    timeoutId = setTimeout(() => {
      cleanup()
      debugBootstrap("Timed out waiting for socket connection before join", { room, timeoutMs, lastConnectError })
      reject(
        joinFailure(
          lastConnectError
            ? `Timed out waiting for socket connection before joining room "${room}": ${lastConnectError}`
            : `Timed out waiting for socket connection before joining room "${room}"`,
          "timeout"
        )
      )
    }, timeoutMs)
  })
}

function isExpectedJoinInterruption(error: unknown): boolean {
  const reason = joinFailureReason(error)
  return reason === "abort" || reason === "disconnect"
}

function logJoinFailure(context: string, room: string, error: unknown, detail: string): void {
  if (isExpectedJoinInterruption(error)) {
    debugBootstrap(`${context} join interrupted`, { room, error: error instanceof Error ? error.message : error })
    return
  }

  console.error(`[${context}] ${detail}`, error)
}

function emitJoinWithAck(socket: Socket, room: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let settled = false

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      socket.off("disconnect", handleDisconnect)
    }

    const resolveOnce = () => {
      if (settled) return
      settled = true
      cleanup()
      debugBootstrap("Join ack success", { room })
      resolve()
    }

    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      debugBootstrap("Join ack failed", { room, error: error.message })
      reject(error)
    }

    const handleDisconnect = (reason: string) => {
      rejectOnce(joinFailure(`Socket disconnected while joining room "${room}": ${reason}`, "disconnect"))
    }

    socket.on("disconnect", handleDisconnect)

    timeoutId = setTimeout(() => {
      rejectOnce(joinFailure(`Timed out waiting for join ack for room "${room}"`, "timeout"))
    }, timeoutMs)

    debugBootstrap("Emitting join with ack", { room })
    socket.emit("join", room, (result?: JoinAckResult) => {
      if (!result?.ok) {
        rejectOnce(new Error(result?.error ?? `Failed to join room "${room}"`))
        return
      }
      resolveOnce()
    })
  })
}

export async function joinRoomWithAck(socket: Socket, room: string, options?: JoinRoomOptions): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS
  const signal = options?.signal

  if (signal?.aborted) {
    throw joinFailure(`Join aborted for room "${room}"`, "abort")
  }

  const pendingJoins = getPendingJoins(socket)
  const existingJoin = pendingJoins.get(room)
  if (existingJoin) {
    debugBootstrap("Reusing in-flight join promise", { room })
    if (!signal) return existingJoin
    // Race the shared promise against the abort signal so this caller can bail out
    // without cancelling the join for other callers sharing the dedup promise.
    return raceAbortSignal(existingJoin, signal, room)
  }

  debugBootstrap("Starting joinRoomWithAck", { room, timeoutMs })
  const socketContext = getSocketDiagnosticContext(socket)
  const observation = beginConnectivityObservation({
    room: categorizeRoom(room),
    connectionId: socketContext?.connectionId,
    generation: socketContext?.generation,
  })
  observation.record("room_join_start")
  const joinPromise = (async () => {
    try {
      await waitForConnection(socket, room, timeoutMs, observation, signal)
      if (signal?.aborted) throw joinFailure(`Join aborted for room "${room}"`, "abort")
      await emitJoinWithAck(socket, room, timeoutMs)
      observation.record("room_join_ack")
    } catch (error) {
      const failureReason = joinFailureReason(error)
      const reason = failureReason === "abort" || failureReason === "timeout" ? failureReason : "unknown"
      observation.record(failureReason === "abort" ? "room_join_abort" : "room_join_failure", { reason })
      throw error
    }
  })()

  // Cancellable joins skip the dedup map — aborting a shared promise would reject
  // for non-cancellable callers that deduped onto it.
  if (signal) {
    return joinPromise
  }

  pendingJoins.set(room, joinPromise)

  try {
    await joinPromise
  } finally {
    pendingJoins.delete(room)
  }
}

/**
 * Await join, log and swallow failures. For queryFn where the bootstrap fetch
 * should proceed even if the room subscription fails.
 */
export async function joinRoomBestEffort(socket: Socket, room: string, context: string): Promise<void> {
  try {
    await joinRoomWithAck(socket, room)
  } catch (error) {
    logJoinFailure(context, room, error, `Failed to receive join ack for ${room}; continuing with bootstrap fetch`)
  }
}

/**
 * Fire-and-forget join with abort signal. For useEffect where cleanup should
 * cancel any pending join. Non-abort errors are logged.
 */
export function joinRoomFireAndForget(socket: Socket, room: string, signal: AbortSignal, context: string): void {
  void joinRoomWithAck(socket, room, { signal }).catch((error) => {
    if (signal.aborted) return
    logJoinFailure(context, room, error, `Failed to join room ${room}`)
  })
}

function raceAbortSignal(promise: Promise<void>, signal: AbortSignal, room: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false

    const onAbort = () => {
      if (settled) return
      settled = true
      reject(joinFailure(`Join aborted for room "${room}"`, "abort"))
    }

    signal.addEventListener("abort", onAbort, { once: true })

    promise.then(
      () => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbort)
        resolve()
      },
      (err) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
}
