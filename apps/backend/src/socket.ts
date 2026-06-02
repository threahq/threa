import type { Server, Socket } from "socket.io"
import crypto from "crypto"
import type { AuthService } from "@threa/backend-common"
import { createSocketAuthMiddleware } from "./lib/socket-auth"
import { DEVICE_KEY_LENGTH, HEARTBEAT_INTERACTION_THROTTLE_MS } from "@threa/types"
import type { StreamService } from "./features/streams"
import type { PushService } from "./features/push"
import type { UserSocketRegistry } from "./lib/user-socket-registry"
import { AgentSessionRepository, PersonaRepository } from "./features/agents"
import type { SessionAbortRegistry } from "./features/agents"
import { EnclaveRuntimesRepository } from "./features/enclave-runtimes"
import type { EnclaveForwarder } from "./features/enclave-runtimes"
import { UserRepository } from "./features/workspaces"
import { HttpError } from "./lib/errors"
import { logger } from "./lib/logger"
import { wsConnectionsActive, wsConnectionDuration, wsMessagesTotal } from "./lib/observability"

/**
 * Normalize room to pattern for metrics.
 * Replaces IDs with placeholders section-by-section:
 * - ws:abc123 -> ws:{workspaceId}
 * - ws:abc123:stream:xyz789 -> ws:{workspaceId}:stream:{streamId}
 * - ws:abc123:stream:xyz789:thread:def456 -> ws:{workspaceId}:stream:{streamId}:thread:{threadId}
 */
function normalizeRoomPattern(room: string): string {
  return room
    .replace(/^ws:[\w]+/, "ws:{workspaceId}")
    .replace(/stream:[\w]+/, "stream:{streamId}")
    .replace(/thread:[\w]+/, "thread:{threadId}")
    .replace(/agent_session:[\w]+/, "agent_session:{sessionId}")
    .replace(/user:[\w]+/, "user:{userId}")
}

/**
 * Extract workspaceId from room string.
 */
function extractWorkspaceId(room: string): string {
  const match = room.match(/^ws:([^:]+)/)
  return match ? match[1] : "-"
}

function isJoinAccessError(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 403 || error.status === 404)
}

/**
 * Track per-socket state for metrics.
 */
interface SocketMetricsState {
  connectTime: bigint
  joinedRooms: Map<string, { workspaceId: string; roomPattern: string }>
}

interface Dependencies {
  pool: import("pg").Pool
  authService: AuthService
  streamService: StreamService
  pushService: PushService
  userSocketRegistry: UserSocketRegistry
  /** Registry for graceful tool cancellation (e.g. workspace_research) — in-process sessions. */
  sessionAbortRegistry: SessionAbortRegistry
  /** Forwards a graceful cancel to the enclave that owns an E2E session. Null when no internal key. */
  enclaveForwarder?: EnclaveForwarder
}

/**
 * Derives a device key from user-agent.
 * Algorithm contract documented in @threa/types (DEVICE_KEY_LENGTH).
 * Must match frontend's getDeviceKey (use-push-notifications.ts).
 */
function deriveDeviceKey(userAgent: string | undefined): string {
  const input = userAgent || "unknown"
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, DEVICE_KEY_LENGTH)
}

export function registerSocketHandlers(io: Server, deps: Dependencies) {
  const { pool, authService, streamService, pushService, userSocketRegistry, sessionAbortRegistry, enclaveForwarder } =
    deps

  // ===========================================================================
  // Authentication middleware (shared with the voice namespace — see lib/socket-auth)
  // ===========================================================================
  io.use(createSocketAuthMiddleware(authService))

  // ===========================================================================
  // Connection handlers
  // ===========================================================================
  io.on("connection", (socket) => {
    const workosUserId = socket.data.workosUserId
    userSocketRegistry.register(workosUserId, socket)
    logger.debug({ workosUserId, socketId: socket.id }, "Socket connected")

    // Initialize metrics state for this socket
    const metricsState: SocketMetricsState = {
      connectTime: process.hrtime.bigint(),
      joinedRooms: new Map(),
    }

    // Track user rooms per workspace for auto-leave on workspace leave
    const userRooms = new Map<string, { userId: string; userRoom: string }>()

    // =========================================================================
    // Room management
    // =========================================================================
    socket.on("join", async (room: string, callback?: (result: { ok: boolean; error?: string }) => void) => {
      const workspaceId = extractWorkspaceId(room)
      const roomPattern = normalizeRoomPattern(room)
      wsMessagesTotal.inc({
        workspace_id: workspaceId,
        direction: "received",
        event_type: "join",
        room_pattern: roomPattern,
      })

      // Workspace room: ws:${workspaceId}
      const workspaceMatch = room.match(/^ws:([^:]+)$/)
      if (workspaceMatch) {
        const wsId = workspaceMatch[1]
        const workspaceUser = await UserRepository.findByWorkosUserIdInWorkspace(pool, wsId, workosUserId)
        if (!workspaceUser) {
          socket.emit("error", { message: "Not authorized to join this workspace" })
          wsMessagesTotal.inc({ workspace_id: wsId, direction: "sent", event_type: "error", room_pattern: roomPattern })
          callback?.({ ok: false, error: "Not authorized to join this workspace" })
          return
        }
        socket.join(room)

        // Auto-join user room for targeted event delivery (activity, commands, read state)
        const userRoom = `ws:${wsId}:user:${workspaceUser.id}`
        socket.join(userRoom)
        userRooms.set(wsId, { userId: workspaceUser.id, userRoom })

        // Upsert session for push notification suppression (only when push is enabled).
        // Don't set focused — the first heartbeat (emitted immediately on connect)
        // will report the correct document.hasFocus() state.
        if (pushService.isEnabled()) {
          const deviceKey = deriveDeviceKey(socket.handshake.headers["user-agent"])
          pushService.upsertSession({ workspaceId: wsId, userId: workspaceUser.id, deviceKey }).catch((err) => {
            logger.warn({ err, wsId, userId: workspaceUser.id }, "Failed to upsert user session on join")
          })
        }

        // Track metrics
        wsConnectionsActive.inc({ workspace_id: wsId, room_pattern: roomPattern })
        metricsState.joinedRooms.set(room, { workspaceId: wsId, roomPattern })

        logger.debug({ workosUserId, room, userRoom }, "Joined workspace room")
        callback?.({ ok: true })
        return
      }

      // Stream room: ws:${workspaceId}:stream:${streamId}
      const streamMatch = room.match(/^ws:([^:]+):stream:(.+)$/)
      if (streamMatch) {
        const [, wsId, streamId] = streamMatch
        // Resolve user for stream access validation
        const workspaceUser = await UserRepository.findByWorkosUserIdInWorkspace(pool, wsId, workosUserId)
        if (!workspaceUser) {
          socket.emit("error", { message: "Not authorized to join this stream" })
          wsMessagesTotal.inc({ workspace_id: wsId, direction: "sent", event_type: "error", room_pattern: roomPattern })
          callback?.({ ok: false, error: "Not authorized to join this stream" })
          return
        }
        try {
          await streamService.validateStreamAccess(streamId, wsId, workspaceUser.id)
        } catch (error) {
          if (!isJoinAccessError(error)) {
            logger.error({ error, workosUserId, room, wsId, streamId }, "Unexpected error during stream room join")
          }
          socket.emit("error", { message: "Not authorized to join this stream" })
          wsMessagesTotal.inc({ workspace_id: wsId, direction: "sent", event_type: "error", room_pattern: roomPattern })
          callback?.({ ok: false, error: "Not authorized to join this stream" })
          return
        }
        socket.join(room)

        // Track metrics
        wsConnectionsActive.inc({ workspace_id: wsId, room_pattern: roomPattern })
        metricsState.joinedRooms.set(room, { workspaceId: wsId, roomPattern })

        logger.debug({ workosUserId, room }, "Joined stream room")
        callback?.({ ok: true })

        // Bootstrap running-session progress state for this socket. Without
        // this, a refresh mid-research loses everything the timeline card
        // tracked: stepCount drops to 0, currentStepType drops to null, and
        // the card shows "0 steps" until the next live progress event fires.
        //
        // We emit `agent_session:progress` directly to the joining socket
        // (not broadcast) with the current DB-derived state so the
        // useAgentActivity hook populates its entry immediately.
        //
        // Fire-and-forget: a failure here only affects the bootstrap UX, so
        // we log and move on rather than blocking the join ack.
        void emitRunningSessionBootstrap(socket, { pool, wsId, streamId }).catch((err) => {
          logger.warn({ err, wsId, streamId }, "Failed to bootstrap running session progress on stream join")
        })
        return
      }

      // Agent session room: ws:${workspaceId}:agent_session:${sessionId}
      const sessionMatch = room.match(/^ws:([^:]+):agent_session:(.+)$/)
      if (sessionMatch) {
        const [, wsId, agentSessionId] = sessionMatch
        // Verify user has access to the session's stream
        const session = await AgentSessionRepository.findById(pool, agentSessionId)
        if (!session) {
          socket.emit("error", { message: "Session not found" })
          wsMessagesTotal.inc({ workspace_id: wsId, direction: "sent", event_type: "error", room_pattern: roomPattern })
          callback?.({ ok: false, error: "Session not found" })
          return
        }
        // Resolve user for stream access validation
        const workspaceUser = await UserRepository.findByWorkosUserIdInWorkspace(pool, wsId, workosUserId)
        if (!workspaceUser) {
          socket.emit("error", { message: "Not authorized to join this session" })
          wsMessagesTotal.inc({ workspace_id: wsId, direction: "sent", event_type: "error", room_pattern: roomPattern })
          callback?.({ ok: false, error: "Not authorized to join this session" })
          return
        }
        try {
          await streamService.validateStreamAccess(session.streamId, wsId, workspaceUser.id)
        } catch (error) {
          if (!isJoinAccessError(error)) {
            logger.error(
              { error, workosUserId, room, wsId, streamId: session.streamId },
              "Unexpected error during agent session room join"
            )
          }
          socket.emit("error", { message: "Not authorized to join this session" })
          wsMessagesTotal.inc({ workspace_id: wsId, direction: "sent", event_type: "error", room_pattern: roomPattern })
          callback?.({ ok: false, error: "Not authorized to join this session" })
          return
        }
        socket.join(room)
        wsConnectionsActive.inc({ workspace_id: wsId, room_pattern: roomPattern })
        metricsState.joinedRooms.set(room, { workspaceId: wsId, roomPattern })
        logger.debug({ workosUserId, room }, "Joined agent session room")
        callback?.({ ok: true })
        return
      }

      // Unknown room format
      socket.emit("error", { message: "Invalid room format" })
      wsMessagesTotal.inc({
        workspace_id: workspaceId,
        direction: "sent",
        event_type: "error",
        room_pattern: roomPattern,
      })
      callback?.({ ok: false, error: "Invalid room format" })
    })

    socket.on("leave", (room: string) => {
      const workspaceId = extractWorkspaceId(room)
      const roomPattern = normalizeRoomPattern(room)
      wsMessagesTotal.inc({
        workspace_id: workspaceId,
        direction: "received",
        event_type: "leave",
        room_pattern: roomPattern,
      })

      socket.leave(room)

      // Auto-leave user room when leaving a workspace room
      const wsMatch = room.match(/^ws:([^:]+)$/)
      if (wsMatch) {
        const wsId = wsMatch[1]
        const entry = userRooms.get(wsId)
        if (entry) {
          socket.leave(entry.userRoom)
          userRooms.delete(wsId)
        }
      }

      // Track metrics
      const roomInfo = metricsState.joinedRooms.get(room)
      if (roomInfo) {
        wsConnectionsActive.dec({ workspace_id: roomInfo.workspaceId, room_pattern: roomInfo.roomPattern })
        metricsState.joinedRooms.delete(room)
      }

      logger.debug({ workosUserId, room }, "Left room")
    })

    // =========================================================================
    // Graceful research abort: tells the workspace_research tool to stop at the
    // next safe checkpoint and return whatever partial results were collected.
    // The session continues running normally with the partial context — this is
    // NOT the same as deleting/superseding the session, which uses shouldAbort.
    // =========================================================================
    socket.on(
      "agent_session:research:abort",
      async (
        payload: { sessionId?: string; workspaceId?: string },
        callback?: (result: { ok: boolean; error?: string }) => void
      ) => {
        const sessionId = payload?.sessionId
        const workspaceIdFromPayload = payload?.workspaceId
        if (!sessionId || !workspaceIdFromPayload) {
          callback?.({ ok: false, error: "sessionId and workspaceId required" })
          return
        }
        try {
          const session = await AgentSessionRepository.findById(pool, sessionId)
          if (!session) {
            callback?.({ ok: false, error: "Session not found" })
            return
          }
          const workspaceUser = await UserRepository.findByWorkosUserIdInWorkspace(
            pool,
            workspaceIdFromPayload,
            workosUserId
          )
          if (!workspaceUser) {
            callback?.({ ok: false, error: "Not authorized" })
            return
          }
          try {
            await streamService.validateStreamAccess(session.streamId, workspaceIdFromPayload, workspaceUser.id)
          } catch (error) {
            if (!isJoinAccessError(error)) {
              logger.error(
                { error, workosUserId, sessionId, streamId: session.streamId },
                "Unexpected error during research abort auth check"
              )
            }
            callback?.({ ok: false, error: "Not authorized" })
            return
          }
          // Route the abort by ownership: an E2E turn runs in the enclave (its
          // server_id is that EIK), so forward the cancel there; an in-process
          // turn lives in this server's abort registry. Both are graceful —
          // research returns partial findings and the turn still replies.
          const owningEnclave = session.serverId
            ? await EnclaveRuntimesRepository.findByKeyId(pool, session.serverId)
            : null
          const aborted = owningEnclave
            ? ((await enclaveForwarder?.cancelSession(owningEnclave.instanceUrl, sessionId)) ?? false)
            : sessionAbortRegistry.abort(sessionId, "user_abort")
          wsMessagesTotal.inc({
            workspace_id: workspaceIdFromPayload,
            direction: "received",
            event_type: "agent_session:research:abort",
            room_pattern: "ws:{workspaceId}:agent_session:{sessionId}",
          })
          logger.info({ sessionId, workosUserId, aborted }, "Research abort dispatched")
          callback?.({ ok: aborted, error: aborted ? undefined : "No active research to abort" })
        } catch (err) {
          logger.warn({ err, sessionId }, "Research abort handler failed")
          callback?.({ ok: false, error: "Abort failed" })
        }
      }
    )

    // =========================================================================
    // Heartbeat for push notification session tracking
    // =========================================================================
    let lastHeartbeatAt = 0
    // Interaction-driven heartbeats bypass the throttle: the client only emits
    // them on the first interaction after a quiet stretch, and we want the
    // backend to learn about renewed activity within seconds, not up to 30s.
    socket.on("heartbeat", (payload?: { focused?: boolean; interacted?: boolean }) => {
      if (!pushService.isEnabled()) return
      const interacted = payload?.interacted === true
      const now = Date.now()
      if (!interacted && now - lastHeartbeatAt < HEARTBEAT_INTERACTION_THROTTLE_MS) return
      lastHeartbeatAt = now
      const deviceKey = deriveDeviceKey(socket.handshake.headers["user-agent"])
      const focused = payload?.focused === true
      const entries = Array.from(userRooms, ([wsId, entry]) => ({
        workspaceId: wsId,
        userId: entry.userId,
        deviceKey,
      }))
      if (entries.length === 0) return
      pushService.upsertSessionsBatch(entries, { focused, interacted }).catch((err) => {
        logger.warn({ err }, "Failed to upsert sessions on heartbeat")
      })
    })

    // Liveness probe for client-initiated zombie-socket detection on resume.
    // Distinct from socket.io's transport-level ping so we can ack synchronously
    // without coupling to the native pingTimeout cycle.
    socket.on("health:ping", (callback?: (result: { ok: true }) => void) => {
      callback?.({ ok: true })
    })

    socket.on("disconnect", () => {
      userSocketRegistry.unregister(workosUserId, socket)

      // Clean up metrics for all joined rooms
      const connectionDurationSeconds = Number(process.hrtime.bigint() - metricsState.connectTime) / 1e9
      const workspaceIds = new Set<string>()

      for (const [, roomInfo] of metricsState.joinedRooms) {
        wsConnectionsActive.dec({ workspace_id: roomInfo.workspaceId, room_pattern: roomInfo.roomPattern })
        workspaceIds.add(roomInfo.workspaceId)
      }

      // Observe duration per unique workspace
      for (const workspaceId of workspaceIds) {
        wsConnectionDuration.observe({ workspace_id: workspaceId }, connectionDurationSeconds)
      }

      metricsState.joinedRooms.clear()
      logger.debug({ workosUserId, socketId: socket.id }, "Socket disconnected")
    })
  })
}

/**
 * Bootstrap a running-session progress snapshot to a freshly-joined socket.
 *
 * Called after a socket joins a stream room. Looks up any currently-running
 * agent session whose streamId matches the joined room (scratchpad/thread/DM)
 * and emits a synthetic `agent_session:progress` event directly to this
 * single socket with DB-derived counts. The frontend's useAgentActivity hook
 * treats this just like a live progress event and populates its entry.
 *
 * Exactly one running session per stream is enforced by the partial unique
 * index on agent_sessions (stream_id) WHERE status='running', so a single
 * findRunningByStream lookup is sufficient.
 *
 * NOTE: channel-mention sessions live in a thread stream, not the channel
 * itself. Bootstrapping a channel room join would require a root-stream
 * lookup; not handled here in V1. The user sees the live updates once they
 * open the thread.
 */
async function emitRunningSessionBootstrap(
  socket: Socket,
  params: { pool: import("pg").Pool; wsId: string; streamId: string }
): Promise<void> {
  const { pool, wsId, streamId } = params
  const session = await AgentSessionRepository.findRunningByStream(pool, streamId)
  if (!session) return

  const [steps, persona] = await Promise.all([
    AgentSessionRepository.findStepsBySession(pool, session.id),
    PersonaRepository.findById(pool, session.personaId, wsId),
  ])

  const stepCount = steps.length
  const messageCount = steps.filter(
    (step) => step.stepType === "message_sent" || step.stepType === "message_edited"
  ).length

  // currentStepType is nullable on the session row (null before the first
  // step fires). Skip the emit in that edge case — nothing meaningful to
  // show yet, and the next live progress event will populate the entry.
  if (!session.currentStepType) return

  socket.emit("agent_session:progress", {
    workspaceId: wsId,
    streamId,
    sessionId: session.id,
    triggerMessageId: session.triggerMessageId,
    personaName: persona?.name ?? "Agent",
    stepCount,
    messageCount,
    currentStepType: session.currentStepType,
    // threadStreamId is only meaningful for channel-mention sessions. Direct
    // stream-room joins (scratchpad/thread/DM) don't need it.
    threadStreamId: undefined,
  })
}
