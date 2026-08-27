import { useMemo, useState, useEffect, useCallback, useRef } from "react"
import type { Socket } from "socket.io-client"
import { useSocketReconnectCount } from "@/contexts"
import type {
  StreamEvent,
  AgentStepType,
  AgentSessionProgressPayload,
  AgentSessionSubstepPayload,
  AgentActivityStartedPayload,
  AgentActivityEndedPayload,
} from "@threa/types"
import { THREAD_ANCHORABLE_EVENT_TYPES } from "@threa/types"
import { getStepInlineLabel } from "@/lib/step-config"
import { decryptAgentSubstepText } from "@/lib/crypto/agent-substep"
import { deriveAgentSessionLifecycle } from "@/lib/agent-session-lifecycle"
import { reconcileAgentActivityFromStreamLifecycle } from "@/stores/agent-activity-store"

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

export { getStepInlineLabel as getStepLabel }

interface ProgressEntry {
  triggerMessageId: string
  personaName: string
  currentStepType: AgentStepType | null
  stepCount: number
  messageCount: number
  substep: string | null
  /**
   * `updatedAt` of the currently-applied substep. Gates out-of-order writes: a
   * decrypt that resolves after a newer one (or a duplicate redelivery) carries an
   * older/equal timestamp and is dropped, so the latest phase always wins.
   */
  substepUpdatedAt?: string
  threadStreamId?: string
  /**
   * For sessions running inside a thread: the thread's parent message id. The
   * parent stream's timeline has no row for the trigger message, so the result
   * map also keys the activity under this id — that's what lights up the
   * thread slot on the parent message.
   */
  parentMessageId?: string
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
  userId: string | null,
  streamId?: string,
  rootStreamId?: string
): Map<string, MessageAgentActivity> {
  const [progressBySession, setProgressBySession] = useState<Map<string, ProgressEntry>>(new Map())
  const reconnectCount = useSocketReconnectCount()

  // The socket sits in EVERY member stream's room (sync-engine joins them all
  // for sidebar updates), so progress/activity events for unrelated streams'
  // sessions arrive here too. A stream view passes `streamId` to gate entry
  // creation to its own sessions: the session's stream, its thread (payload
  // threadStreamId), or a thread under one of this view's messages (payload
  // parentMessageId). Omit it (board rows) to accept all sessions — those
  // callers match by sessionId themselves.
  const viewMessageIds = useMemo(() => {
    if (streamId === undefined) return null
    const ids = new Set<string>()
    for (const event of events) {
      // The anchor a session's parent-room indicator keys on: a message's id, or
      // a threadable card's event id (delegation/call chat sessions anchor there).
      if (event.eventType === "message_created") {
        ids.add((event.payload as { messageId: string }).messageId)
      } else if (THREAD_ANCHORABLE_EVENT_TYPES.includes(event.eventType)) {
        ids.add(event.id)
      }
    }
    return ids
  }, [events, streamId])
  const viewMessageIdsRef = useRef(viewMessageIds)
  useEffect(() => {
    viewMessageIdsRef.current = viewMessageIds
  }, [viewMessageIds])

  const belongsToView = useCallback(
    (payload: { streamId?: string; threadStreamId?: string; parentMessageId?: string }) => {
      if (streamId === undefined) return true
      if (payload.streamId === streamId || payload.threadStreamId === streamId) return true
      return payload.parentMessageId !== undefined && (viewMessageIdsRef.current?.has(payload.parentMessageId) ?? false)
    },
    [streamId]
  )

  // StreamContent persists across `streamId` changes (the route param swaps in
  // place), so without a reset the previous stream's socket-only entries would
  // leak into the next view's map.
  useEffect(() => {
    setProgressBySession((prev) => (prev.size === 0 ? prev : new Map()))
  }, [streamId])

  // Mirror of `progressBySession` for synchronous reads inside event handlers —
  // lets a substep capture the session's step generation at *arrival* time so a
  // late async decrypt can't apply onto a step that has since moved on.
  const progressRef = useRef(progressBySession)
  useEffect(() => {
    progressRef.current = progressBySession
  }, [progressBySession])

  // Socket-only entries have exactly one deletion path: the activity_ended
  // event. A disconnect that swallows it would strand a "working" indicator
  // forever (the parent-view alias has no events-array cleanup — the session's
  // lifecycle events live in the thread, not this stream). Reset the slate on
  // reconnect (INV-53): a session still running re-announces itself on its next
  // progress/substep emit, and the stream-room rejoin bootstrap re-seeds the
  // session's own stream immediately.
  useEffect(() => {
    if (reconnectCount === 0) return
    setProgressBySession((prev) => (prev.size === 0 ? prev : new Map()))
  }, [reconnectCount])

  // Stream and sidebar activity share this lifecycle projection, so observing a
  // terminal event in the timeline clears both surfaces.
  const lifecycle = useMemo(() => deriveAgentSessionLifecycle(events), [events])
  const runningSessions = lifecycle.running

  useEffect(() => {
    if (!streamId) return
    reconcileAgentActivityFromStreamLifecycle(workspaceId, streamId, rootStreamId ?? streamId, lifecycle)
  }, [lifecycle, rootStreamId, streamId, workspaceId])

  // When a session terminates in the events array (e.g. thread view), clean up its progress entry
  useEffect(() => {
    setProgressBySession((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const sessionId of next.keys()) {
        // Progress-only sessions belong to a parent view and have no lifecycle
        // rows here; activity_ended owns their cleanup.
        if (lifecycle.terminated.has(sessionId)) {
          next.delete(sessionId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [lifecycle])

  // Activity started: session just began, no step yet (renders "Working...")
  const handleActivityStarted = useCallback(
    (payload: AgentActivityStartedPayload) => {
      if (!belongsToView(payload)) return
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
          parentMessageId: payload.parentMessageId,
        })
        return next
      })
    },
    [belongsToView]
  )

  // Progress: step type update during active session.
  // When the stepCount changes, the previous step's live substep is stale — clear it
  // so we don't show e.g. "Evaluating results…" left over from workspace_search after
  // we've moved on to "thinking" or "message_sent".
  const handleProgress = useCallback(
    (payload: AgentSessionProgressPayload) => {
      if (!belongsToView(payload)) return
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
          substepUpdatedAt: sameStep ? prior?.substepUpdatedAt : undefined,
          threadStreamId: payload.threadStreamId,
          parentMessageId: payload.parentMessageId,
        })
        return next
      })
    },
    [belongsToView]
  )

  // Apply a decoded substep, gated against races: drop it if the session's step
  // generation advanced since the substep arrived (`stepCountAtArrival`), or if a
  // newer substep already landed (`updatedAt` ordering). Both guard the async E2E
  // decrypt, whose resolution order isn't the arrival order.
  const applySubstep = useCallback(
    (sessionId: string, text: string, updatedAt: string, stepCountAtArrival: number | undefined) => {
      setProgressBySession((prev) => {
        const existing = prev.get(sessionId)
        if (!existing) return prev
        if (stepCountAtArrival !== undefined && existing.stepCount !== stepCountAtArrival) return prev
        if (existing.substepUpdatedAt && updatedAt <= existing.substepUpdatedAt) return prev
        const next = new Map(prev)
        next.set(sessionId, { ...existing, substep: text, substepUpdatedAt: updatedAt })
        return next
      })
    },
    []
  )

  // Substep: ephemeral phase text from a long-running tool. Only updates the entry
  // for the matching session — does NOT touch step counts or step type. For E2E
  // (enclave) sessions the text is sealed under the stream key, so decrypt it the
  // same way message/step content is before applying.
  const handleSubstep = useCallback(
    (payload: AgentSessionSubstepPayload) => {
      // Capture the step generation at arrival so a late decrypt can't apply onto
      // a step that has since advanced.
      const stepCountAtArrival = progressRef.current.get(payload.sessionId)?.stepCount
      if (typeof payload.substep === "string" && payload.substep) {
        applySubstep(payload.sessionId, payload.substep, payload.updatedAt, stepCountAtArrival)
        return
      }
      if (typeof payload.ciphertext === "string" && payload.envelope) {
        const { ciphertext, envelope, streamId: substepStreamId, sessionId, updatedAt } = payload
        void (async () => {
          const text = await decryptAgentSubstepText(
            { streamId: substepStreamId, ciphertext, envelope },
            { workspaceId, userId: userId ?? "" }
          )
          if (text) applySubstep(sessionId, text, updatedAt, stepCountAtArrival)
        })()
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

    // For a session running inside a thread, the parent stream's timeline has
    // no row for the trigger message — the visible anchor there is the thread's
    // parent message. Alias the same activity under that id so the thread slot
    // lights up. Trigger-message keys win on collision (set first, never
    // clobbered) since they anchor the session's own stream view.
    const aliasUnderParentMessage = (parentMessageId: string | undefined, activity: MessageAgentActivity) => {
      if (parentMessageId && !result.has(parentMessageId)) {
        result.set(parentMessageId, activity)
      }
    }

    // Sessions known from events (thread/scratchpad view)
    for (const [sessionId, session] of runningSessions) {
      const progress = progressBySession.get(sessionId)
      const activity: MessageAgentActivity = {
        sessionId,
        personaName: progress?.personaName ?? session.personaName,
        currentStepType: progress ? progress.currentStepType : session.currentStepType,
        stepCount: progress ? progress.stepCount : (session.stepCount ?? 0),
        messageCount: progress ? progress.messageCount : (session.messageCount ?? 0),
        substep: progress?.substep ?? null,
        threadStreamId: progress?.threadStreamId,
      }
      result.set(session.triggerMessageId, activity)
      aliasUnderParentMessage(progress?.parentMessageId, activity)
    }

    // Sessions known only from socket (parent view where lifecycle events are in the thread)
    for (const [sessionId, progress] of progressBySession) {
      if (runningSessions.has(sessionId)) continue
      const activity: MessageAgentActivity = {
        sessionId,
        personaName: progress.personaName,
        currentStepType: progress.currentStepType,
        stepCount: progress.stepCount,
        messageCount: progress.messageCount,
        substep: progress.substep,
        threadStreamId: progress.threadStreamId,
      }
      result.set(progress.triggerMessageId, activity)
      aliasUnderParentMessage(progress.parentMessageId, activity)
    }

    return result
  }, [runningSessions, progressBySession])
}
