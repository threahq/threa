import { useMemo, useState, useEffect, useCallback } from "react"
import type { Socket } from "socket.io-client"
import type {
  StreamEvent,
  AgentStepType,
  AgentSessionStartedPayload,
  AgentSessionCompletedPayload,
  AgentSessionFailedPayload,
  AgentSessionDeletedPayload,
  AgentSessionProgressPayload,
  AgentSessionSubstepPayload,
  AgentActivityStartedPayload,
  AgentActivityEndedPayload,
} from "@threa/types"
import { getStepInlineLabel } from "@/lib/step-config"
import { getE2eSessionState } from "@/stores/e2e-session-store"
import { tryDecryptMessagePayload } from "@/lib/crypto/message-envelope"

export interface MessageAgentActivity {
  sessionId: string
  personaName: string
  currentStepType: AgentStepType | null
  stepCount: number
  messageCount: number
  /**
   * Latest live substep text emitted by a long-running tool (e.g. workspace_research).
   * Cleared automatically when the step type changes or the session ends.
   * Null when no substep has been received for the current step yet — callers should
   * fall back to the step type's inline label in that case.
   */
  substep: string | null
  /** Thread stream ID for channel mentions - allows linking directly to thread */
  threadStreamId?: string
}

// Re-export from consolidated config for backward compatibility
export { getStepInlineLabel as getStepLabel }

interface ProgressEntry {
  triggerMessageId: string
  personaName: string
  currentStepType: AgentStepType | null
  stepCount: number
  messageCount: number
  substep: string | null
  threadStreamId?: string
}

/**
 * Derives a map of triggerMessageId → activity state from:
 * 1. Events array (bootstrap): scan for started sessions without matching completed/failed
 * 2. Socket (live): activity_started, progress, and activity_ended events
 *
 * For channel views, session lifecycle events live in the thread stream (not the channel).
 * The hook handles this by also including sessions known only from socket events.
 * The activity_started event fires immediately when the session begins (no step yet),
 * progress events update the step type, and activity_ended cleans up.
 */
export function useAgentActivity(
  events: StreamEvent[],
  socket: Socket | null,
  workspaceId: string,
  userId: string | null
): Map<string, MessageAgentActivity> {
  // Track live activity from socket: sessionId → { triggerMessageId, personaName, currentStepType }
  const [progressBySession, setProgressBySession] = useState<Map<string, ProgressEntry>>(new Map())

  // Derive running sessions from events array (bootstrap source of truth for streams
  // that contain session lifecycle events, e.g. threads and scratchpads)
  const runningSessions = useMemo(() => {
    const started = new Map<
      string,
      {
        triggerMessageId: string
        personaName: string
        currentStepType: AgentStepType | null
        stepCount: number
        messageCount: number
      }
    >()
    const terminated = new Set<string>()

    for (const event of events) {
      switch (event.eventType) {
        case "agent_session:started": {
          const payload = event.payload as AgentSessionStartedPayload
          started.set(payload.sessionId, {
            triggerMessageId: payload.triggerMessageId,
            personaName: payload.personaName,
            currentStepType: payload.currentStepType ?? null,
            stepCount: payload.stepCount ?? 0,
            messageCount: payload.messageCount ?? 0,
          })
          break
        }
        case "agent_session:completed": {
          const payload = event.payload as AgentSessionCompletedPayload
          terminated.add(payload.sessionId)
          break
        }
        case "agent_session:failed": {
          const payload = event.payload as AgentSessionFailedPayload
          terminated.add(payload.sessionId)
          break
        }
        case "agent_session:deleted": {
          const payload = event.payload as AgentSessionDeletedPayload
          terminated.add(payload.sessionId)
          break
        }
      }
    }

    // Running = started minus terminated
    for (const id of terminated) {
      started.delete(id)
    }

    return started
  }, [events])

  // When a session terminates in the events array (e.g. thread view), clean up its progress entry
  useEffect(() => {
    setProgressBySession((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const sessionId of next.keys()) {
        // Only remove if we have BOTH started AND terminated in events (i.e. not in runningSessions).
        // Don't remove progress-only sessions (channel view) — those are cleaned up by activity_ended.
        if (!runningSessions.has(sessionId) && hasTerminatedInEvents(events, sessionId)) {
          next.delete(sessionId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [runningSessions, events])

  // Activity started: session just began, no step yet (renders "Working...")
  const handleActivityStarted = useCallback((payload: AgentActivityStartedPayload) => {
    setProgressBySession((prev) => {
      const next = new Map(prev)
      next.set(payload.sessionId, {
        triggerMessageId: payload.triggerMessageId,
        personaName: payload.personaName,
        currentStepType: null,
        stepCount: 0,
        messageCount: 0,
        substep: null,
        threadStreamId: payload.threadStreamId,
      })
      return next
    })
  }, [])

  // Progress: step type update during active session.
  // When the stepCount changes, the previous step's live substep is stale — clear it
  // so we don't show e.g. "Evaluating results…" left over from workspace_search after
  // we've moved on to "thinking" or "message_sent".
  const handleProgress = useCallback((payload: AgentSessionProgressPayload) => {
    setProgressBySession((prev) => {
      const prior = prev.get(payload.sessionId)
      const sameStep = prior?.stepCount === payload.stepCount
      const next = new Map(prev)
      next.set(payload.sessionId, {
        triggerMessageId: payload.triggerMessageId,
        personaName: payload.personaName,
        currentStepType: payload.currentStepType,
        stepCount: payload.stepCount,
        messageCount: payload.messageCount,
        substep: sameStep ? (prior?.substep ?? null) : null,
        threadStreamId: payload.threadStreamId,
      })
      return next
    })
  }, [])

  const applySubstep = useCallback((sessionId: string, text: string) => {
    setProgressBySession((prev) => {
      const existing = prev.get(sessionId)
      if (!existing) return prev
      const next = new Map(prev)
      next.set(sessionId, { ...existing, substep: text })
      return next
    })
  }, [])

  // Substep: ephemeral phase text from a long-running tool. Only updates the entry
  // for the matching session — does NOT touch step counts or step type. For E2E
  // (enclave) sessions the text is sealed under the stream key, so decrypt it the
  // same way message/step content is before applying.
  const handleSubstep = useCallback(
    (payload: AgentSessionSubstepPayload) => {
      if (typeof payload.substep === "string" && payload.substep) {
        applySubstep(payload.sessionId, payload.substep)
        return
      }
      if (typeof payload.ciphertext === "string" && payload.envelope) {
        const session = getE2eSessionState(workspaceId, userId ?? "")
        if (session.status !== "unlocked" || !session.privateKey || !session.keyId) return
        void tryDecryptMessagePayload(
          { contentMarkdown: "", ciphertext: payload.ciphertext, envelope: payload.envelope },
          { privateKey: session.privateKey, recipientKeyId: session.keyId, workspaceId, streamId: payload.streamId }
        )
          .then((decrypted) => {
            if (decrypted?.contentMarkdown) applySubstep(payload.sessionId, decrypted.contentMarkdown)
          })
          .catch(() => {})
      }
    },
    [workspaceId, userId, applySubstep]
  )

  // Activity ended: session completed/failed, remove from map
  const handleActivityEnded = useCallback((payload: AgentActivityEndedPayload) => {
    setProgressBySession((prev) => {
      if (!prev.has(payload.sessionId)) return prev
      const next = new Map(prev)
      next.delete(payload.sessionId)
      return next
    })
  }, [])

  useEffect(() => {
    if (!socket) return

    socket.on("agent_session:activity_started", handleActivityStarted)
    socket.on("agent_session:progress", handleProgress)
    socket.on("agent_session:substep", handleSubstep)
    socket.on("agent_session:activity_ended", handleActivityEnded)
    return () => {
      socket.off("agent_session:activity_started", handleActivityStarted)
      socket.off("agent_session:progress", handleProgress)
      socket.off("agent_session:substep", handleSubstep)
      socket.off("agent_session:activity_ended", handleActivityEnded)
    }
  }, [socket, handleActivityStarted, handleProgress, handleSubstep, handleActivityEnded])

  // Build final map: triggerMessageId → activity
  // Includes sessions from events (runningSessions) AND socket-only sessions (channel view)
  return useMemo(() => {
    const result = new Map<string, MessageAgentActivity>()

    // Sessions known from events (thread/scratchpad view)
    for (const [sessionId, session] of runningSessions) {
      const progress = progressBySession.get(sessionId)
      result.set(session.triggerMessageId, {
        sessionId,
        personaName: progress?.personaName ?? session.personaName,
        currentStepType: progress ? progress.currentStepType : session.currentStepType,
        stepCount: progress ? progress.stepCount : session.stepCount,
        messageCount: progress ? progress.messageCount : session.messageCount,
        substep: progress?.substep ?? null,
        threadStreamId: progress?.threadStreamId,
      })
    }

    // Sessions known only from socket (channel view where lifecycle events are in thread)
    for (const [sessionId, progress] of progressBySession) {
      if (runningSessions.has(sessionId)) continue
      result.set(progress.triggerMessageId, {
        sessionId,
        personaName: progress.personaName,
        currentStepType: progress.currentStepType,
        stepCount: progress.stepCount,
        messageCount: progress.messageCount,
        substep: progress.substep,
        threadStreamId: progress.threadStreamId,
      })
    }

    return result
  }, [runningSessions, progressBySession])
}

/** Check if a session has a terminal event (completed/failed) in the events array */
function hasTerminatedInEvents(events: StreamEvent[], sessionId: string): boolean {
  return events.some(
    (e) =>
      (e.eventType === "agent_session:completed" ||
        e.eventType === "agent_session:failed" ||
        e.eventType === "agent_session:deleted") &&
      (e.payload as AgentSessionCompletedPayload | AgentSessionFailedPayload | AgentSessionDeletedPayload).sessionId ===
        sessionId
  )
}
