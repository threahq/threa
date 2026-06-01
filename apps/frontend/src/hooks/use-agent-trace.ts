import { useCallback, useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSocket } from "@/contexts"
import { agentSessionsApi } from "@/api"
import { debugBootstrap } from "@/lib/bootstrap-debug"
import { joinRoomWithAck } from "@/lib/socket-room"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { getE2eSessionState } from "@/stores/e2e-session-store"
import { tryDecryptMessagePayload } from "@/lib/crypto/message-envelope"
import type {
  AgentSessionStep,
  AgentSession,
  AgentSessionStatus,
  AgentSessionWithSteps,
  AgentSessionSubstepPayload,
  StepStartedPayload,
  StepProgressPayload,
  StepCompletedPayload,
  SessionTerminalPayload,
  AgentStepType,
} from "@threa/types"

/**
 * In-memory snapshot of substep history for an in-flight tool step.
 * Cleared on `agent_session:step:completed` once the persisted version (baked into
 * step.content for tools that opt in) takes over.
 */
export interface StreamingSubstep {
  text: string
  at: string
}

interface UseAgentTraceResult {
  steps: AgentSessionStep[]
  streamingContent: Record<string, string>
  /**
   * Live substep timeline keyed by step type. Substep events arrive without a
   * stepId (the step row may not exist yet at emission time), so we key by step
   * type — there's only one in-flight step of each type at a time within a single
   * iteration of the agent loop. On step completion, the persisted step.content
   * provides the canonical history and these entries are cleared.
   */
  streamingSubsteps: Partial<Record<AgentStepType, StreamingSubstep[]>>
  session: AgentSession | null
  relatedSessions: AgentSession[]
  persona: AgentSessionWithSteps["persona"] | null
  status: AgentSessionStatus | null
  isLoading: boolean
  error: Error | null
}

/**
 * Subscribe-then-bootstrap hook for agent trace steps.
 *
 * CRITICAL: We must subscribe BEFORE fetching to avoid missing events.
 * The pattern is:
 * 1. Join session room (socket subscription)
 * 2. Listen for real-time step events
 * 3. After subscription confirmed, fetch API for historical data
 * 4. Merge: real-time steps win on ID collision
 *
 * This prevents the race where we fetch data, miss an event, then subscribe.
 */
export function useAgentTrace(workspaceId: string, sessionId: string): UseAgentTraceResult {
  const socket = useSocket()
  const userId = useWorkspaceUserId(workspaceId)

  // Real-time state accumulated from socket events
  const [realtimeSteps, setRealtimeSteps] = useState<Map<string, AgentSessionStep>>(new Map())
  const [streamingContent, setStreamingContent] = useState<Record<string, string>>({})
  const [streamingSubsteps, setStreamingSubsteps] = useState<Partial<Record<AgentStepType, StreamingSubstep[]>>>({})
  const [terminalStatus, setTerminalStatus] = useState<"completed" | "failed" | null>(null)
  // Track if socket is subscribed (enables query after subscription)
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [isSubscribing, setIsSubscribing] = useState(false)
  const [subscriptionError, setSubscriptionError] = useState<Error | null>(null)

  // Bootstrap: single fetch for historical data. Real-time updates come via socket.
  // IMPORTANT: Only fetch AFTER socket subscription is confirmed to avoid race conditions
  const {
    data,
    isLoading: isQueryLoading,
    error: queryError,
  } = useQuery({
    queryKey: ["agent-session", workspaceId, sessionId],
    queryFn: () => agentSessionsApi.getSession(workspaceId, sessionId),
    enabled: !!workspaceId && !!sessionId && isSubscribed,
    // Always refetch when modal opens - don't serve stale data from a previous view
    staleTime: 0,
  })

  debugBootstrap("Agent trace observer state", {
    workspaceId,
    sessionId,
    hasSocket: !!socket,
    isSubscribed,
    isSubscribing,
    queryLoading: isQueryLoading,
    hasQueryError: !!queryError,
  })

  const handleStepStarted = useCallback(
    (payload: StepStartedPayload) => {
      if (payload?.sessionId !== sessionId || !payload.step?.id) return
      setRealtimeSteps((prev) => {
        const next = new Map(prev)
        next.set(payload.step.id, payload.step)
        return next
      })
    },
    [sessionId]
  )

  const handleStepProgress = useCallback(
    (payload: StepProgressPayload) => {
      if (payload?.sessionId !== sessionId || !payload.stepId) return
      if (payload.content != null) {
        setStreamingContent((prev) => ({ ...prev, [payload.stepId]: payload.content! }))
      }
    },
    [sessionId]
  )

  const handleStepCompleted = useCallback(
    (payload: StepCompletedPayload) => {
      if (payload?.sessionId !== sessionId || !payload.step?.id) return
      setRealtimeSteps((prev) => {
        const next = new Map(prev)
        next.set(payload.step.id, payload.step)
        return next
      })
      // Clear streaming content for completed step
      setStreamingContent((prev) => {
        const { [payload.step.id]: _, ...rest } = prev
        return rest
      })
      // Clear streaming substeps for the step type — the persisted step.content now
      // carries the canonical history, so refresh-stable rendering takes over.
      const completedType = payload.step.stepType
      if (completedType) {
        setStreamingSubsteps((prev) => {
          if (!(completedType in prev)) return prev
          const next = { ...prev }
          delete next[completedType]
          return next
        })
      }
    },
    [sessionId]
  )

  // Substep: ephemeral phase text from a long-running tool. We accumulate per
  // step type so the trace dialog can render an inline timeline of phases for the
  // currently in-flight step. Cleared on step completion (handleStepCompleted).
  const appendSubstep = useCallback((stepType: AgentStepType, text: string, at: string) => {
    setStreamingSubsteps((prev) => {
      const list = prev[stepType] ?? []
      // Dedupe consecutive identical substeps (the backend may emit the same phase twice on retry)
      if (list.length > 0 && list[list.length - 1]?.text === text) return prev
      return { ...prev, [stepType]: [...list, { text, at }] }
    })
  }, [])

  const handleSubstep = useCallback(
    (payload: AgentSessionSubstepPayload) => {
      if (payload?.sessionId !== sessionId || !payload.stepType) return
      // Plaintext (non-E2E) substep.
      if (typeof payload.substep === "string" && payload.substep) {
        appendSubstep(payload.stepType, payload.substep, payload.updatedAt)
        return
      }
      // E2E: the phase text is sealed under the stream key (it's derived from the
      // encrypted prompt). Decrypt it the same way message/step content is, then
      // apply. Silently skip if the session isn't unlocked.
      if (typeof payload.ciphertext === "string" && payload.envelope) {
        const session = getE2eSessionState(workspaceId, userId ?? "")
        if (session.status !== "unlocked" || !session.privateKey || !session.keyId) return
        void tryDecryptMessagePayload(
          { contentMarkdown: "", ciphertext: payload.ciphertext, envelope: payload.envelope },
          { privateKey: session.privateKey, recipientKeyId: session.keyId, workspaceId, streamId: payload.streamId }
        )
          .then((decrypted) => {
            if (decrypted?.contentMarkdown)
              appendSubstep(payload.stepType, decrypted.contentMarkdown, payload.updatedAt)
          })
          .catch(() => {})
      }
    },
    [sessionId, workspaceId, userId, appendSubstep]
  )

  const handleCompleted = useCallback(
    (payload: SessionTerminalPayload) => {
      if (payload?.sessionId !== sessionId) return
      setTerminalStatus("completed")
    },
    [sessionId]
  )

  const handleFailed = useCallback(
    (payload: SessionTerminalPayload) => {
      if (payload?.sessionId !== sessionId) return
      setTerminalStatus("failed")
    },
    [sessionId]
  )

  // Subscribe to session room and listen for events
  // CRITICAL: Subscription must complete BEFORE query is enabled to avoid race conditions
  useEffect(() => {
    if (!socket || !workspaceId || !sessionId) return

    const room = `ws:${workspaceId}:agent_session:${sessionId}`
    const abortController = new AbortController()

    // Reset state for new session
    setRealtimeSteps(new Map())
    setStreamingContent({})
    setStreamingSubsteps({})
    setTerminalStatus(null)
    setIsSubscribed(false)
    setIsSubscribing(true)
    setSubscriptionError(null)

    // Set up event listeners
    socket.on("agent_session:step:started", handleStepStarted)
    socket.on("agent_session:step:progress", handleStepProgress)
    socket.on("agent_session:step:completed", handleStepCompleted)
    socket.on("agent_session:substep", handleSubstep)
    socket.on("agent_session:completed", handleCompleted)
    socket.on("agent_session:failed", handleFailed)

    // Subscribe to session room FIRST and only fetch bootstrap after join ack.
    debugBootstrap("Agent trace joining session room", { workspaceId, sessionId, room })
    void joinRoomWithAck(socket, room, { signal: abortController.signal })
      .then(() => {
        setIsSubscribed(true)
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return
        const joinError = error instanceof Error ? error : new Error("Failed to subscribe to session room")
        console.error(
          `[AgentTrace] Failed to receive join ack for ${room}; continuing with bootstrap fetch and realtime listeners`,
          joinError
        )
        setSubscriptionError(joinError)
        setIsSubscribed(true)
      })
      .finally(() => {
        if (abortController.signal.aborted) return
        setIsSubscribing(false)
      })

    return () => {
      abortController.abort()
      setIsSubscribed(false)
      socket.emit("leave", room)
      socket.off("agent_session:step:started", handleStepStarted)
      socket.off("agent_session:step:progress", handleStepProgress)
      socket.off("agent_session:step:completed", handleStepCompleted)
      socket.off("agent_session:substep", handleSubstep)
      socket.off("agent_session:completed", handleCompleted)
      socket.off("agent_session:failed", handleFailed)
    }
  }, [
    socket,
    workspaceId,
    sessionId,
    handleStepStarted,
    handleStepProgress,
    handleStepCompleted,
    handleSubstep,
    handleCompleted,
    handleFailed,
  ])

  // Merge bootstrap + realtime steps (realtime wins on ID collision)
  const mergedSteps = mergeSteps(data?.steps ?? [], realtimeSteps)

  // Determine status: prefer terminal socket event, then API data
  const status: AgentSessionStatus | null = terminalStatus ?? data?.session.status ?? null

  return {
    steps: mergedSteps,
    streamingContent,
    streamingSubsteps,
    session: data?.session ?? null,
    relatedSessions: data?.relatedSessions ?? [],
    persona: data?.persona ?? null,
    status,
    isLoading: isSubscribing || isQueryLoading,
    error: (queryError as Error | null) ?? (data ? null : subscriptionError),
  }
}

function mergeSteps(apiSteps: AgentSessionStep[], realtimeSteps: Map<string, AgentSessionStep>): AgentSessionStep[] {
  const merged = new Map<string, AgentSessionStep>()

  // Add API steps first
  for (const step of apiSteps) {
    merged.set(step.id, step)
  }

  // Realtime steps override (more recent data)
  for (const [id, step] of realtimeSteps) {
    merged.set(id, step)
  }

  // Sort by stepNumber
  return Array.from(merged.values()).sort((a, b) => a.stepNumber - b.stepNumber)
}
