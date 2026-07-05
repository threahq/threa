import { useCallback } from "react"
import type { Socket } from "socket.io-client"

interface AbortAck {
  ok: boolean
  error?: string
}

/**
 * Returns a callback that asks the backend to gracefully stop a running agent
 * session. Stop is cooperative — the loop halts at its next safe checkpoint
 * (an in-flight LLM call or long fetch is cancelled) and the turn wraps up
 * with whatever it already has instead of failing.
 *
 * The handler emits `agent_session:research:abort` — the wire event keeps its
 * historical name for client compat (INV-49); the backend aborts the whole
 * session regardless of which tool is active. Errors are logged but not
 * surfaced — there's nothing the user can do about them, and the abort is
 * best-effort by design (the session may have already completed by the time
 * the click reaches the server).
 */
export function useAbortSession(socket: Socket | null) {
  return useCallback(
    (params: { sessionId: string; workspaceId: string }) => {
      if (!socket) return
      socket.emit(
        "agent_session:research:abort",
        { sessionId: params.sessionId, workspaceId: params.workspaceId },
        (ack: AbortAck | undefined) => {
          if (!ack?.ok) {
            console.warn("[useAbortSession] abort ack:", ack?.error ?? "no ack")
          }
        }
      )
    },
    [socket]
  )
}
