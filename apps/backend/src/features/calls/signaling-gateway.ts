import type { Server } from "socket.io"
import { z } from "zod"
import type { AuthService, SessionCookies } from "@threa/backend-common"
import type { Pool } from "pg"
import { createSocketAuthMiddleware } from "../../lib/socket-auth"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import { UserRepository } from "../workspaces"
import type { FeatureFlagService } from "../feature-flags"
import { checkCallAccess } from "./access"
import type { CallService, CallRosterSnapshot } from "./service"
import { ENDPOINT_LEASE_TTL_MS, CALL_SOCKET_RATE_BURST, CALL_SOCKET_RATE_REFILL_PER_SEC } from "./config"

export const CALLS_NAMESPACE = "/calls"

/** Room every call member joins — roster/state fan-out target. */
export function callRoom(callId: string): string {
  return `call:${callId}`
}

/** Per-endpoint room — control events are addressed here, never a user room (one device, one command). */
export function endpointRoom(callId: string, endpointId: string): string {
  return `call:${callId}:ep:${endpointId}`
}

/**
 * Fan a versioned roster snapshot to a call's room. Shared by the gateway and
 * the REST proxy handlers (a publish/close over HTTP must reach the sockets), so
 * both fan through the identical `call:roster` shape. Every roster emit carries
 * `rosterVersion` so a reordered delivery is dropped by the client's version
 * check, not trusted.
 */
export function broadcastRoster(io: Server, callId: string, snapshot: CallRosterSnapshot): void {
  io.of(CALLS_NAMESPACE).to(callRoom(callId)).emit("call:roster", {
    callId,
    rosterVersion: snapshot.rosterVersion,
    roster: snapshot.roster,
  })
}

/**
 * Tell a displaced device that another of this user's devices took the call over.
 * Addressed to the superseded endpoint's own room, so only that device hears it.
 *
 * Without this the displaced client learns nothing until its next lease renew
 * fails (`CALL_LEASE_SUPERSEDED`, one TTL/3 away) while its media is already
 * dead — a silent stretch of "Reconnecting…" ending in the call vanishing. The
 * renew remains the backstop for a device that has lost the socket.
 *
 * Only ever called with `supersededEndpointId` from a takeover: a rebind reuses
 * the endpoint id, and this event on that room would tear down the very device
 * that just joined.
 */
export function notifyEndpointTakenOver(io: Server, callId: string, endpointId: string): void {
  io.of(CALLS_NAMESPACE).to(endpointRoom(callId, endpointId)).emit("call:endpoint:closed", {
    callId,
    endpointId,
    reason: "taken_over",
  })
}

const joinSchema = z.object({
  workspaceId: z.string().min(1),
  callId: z.string().min(1),
  mediaIncarnation: z.string().min(1).max(128),
  takeover: z.boolean().optional(),
})

const stateSchema = z.object({
  muted: z.boolean().optional(),
  cameraOn: z.boolean().optional(),
})

interface Dependencies {
  authService: AuthService
  sessionCookies: SessionCookies
  callService: CallService
  featureFlagService: FeatureFlagService
  pool: Pool
  /** False when the CF media plane is unconfigured — every join then acks CALLS_UNAVAILABLE. */
  cloudflareEnabled: boolean
}

interface SocketBinding {
  workspaceId: string
  callId: string
  userId: string
  participantId: string
  endpointId: string
  epoch: number
  connectionSeq: number
  mediaIncarnation: string
}

type Ack = (result: { ok: boolean; error?: string; code?: string; data?: unknown }) => void

/** Continuous-refill token bucket, one per socket (INV — signaling abuse hardening). */
function createTokenBucket() {
  let tokens = CALL_SOCKET_RATE_BURST
  let last = Date.now()
  return {
    take(): boolean {
      const now = Date.now()
      tokens = Math.min(CALL_SOCKET_RATE_BURST, tokens + ((now - last) / 1000) * CALL_SOCKET_RATE_REFILL_PER_SEC)
      last = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}

/**
 * The `/calls` control namespace. Mirrors {@link registerVoiceGateway}: own
 * namespace, the same `createSocketAuthMiddleware`, registered in `server.ts`.
 * Media negotiation does NOT ride this socket — it goes over HTTPS to the CF
 * proxy endpoints, so SDP never touches Socket.io fan-out. This carries only
 * small control events.
 *
 * INV-4 carve-out: `call:join`/`call:leave`/`call:state`/`call:lease:renew` and
 * the `call:roster` fan-out are ephemeral, per-connection control — no durable
 * read model to reconstruct, so they are delivered directly over the socket
 * rather than through the outbox. Roster/state carries a monotonic version so a
 * reordered update is dropped by version check, not trusted.
 */
export function registerCallGateway(io: Server, deps: Dependencies) {
  const { authService, sessionCookies, callService, featureFlagService, pool, cloudflareEnabled } = deps
  const namespace = io.of(CALLS_NAMESPACE)

  namespace.use(createSocketAuthMiddleware({ authService, sessionCookies }))

  // The per-workspace kill-switch (404-style CALLS_DISABLED, mirroring the REST
  // `assertAvailable`). Gated on both `call:join` (reject new joins) and
  // `call:lease:renew` — renewing on the flag lets a live call outlive the switch,
  // so flipping calls off starves every live call within one lease TTL.
  const assertWorkspaceCallsEnabled = async (workspaceId: string): Promise<void> => {
    if ((await featureFlagService.getWorkspaceFlag(workspaceId, "calls")) !== "on") {
      throw new HttpError("Calls are not enabled for this workspace", { status: 404, code: "CALLS_DISABLED" })
    }
  }

  namespace.on("connection", (socket) => {
    const workosUserId = socket.data.workosUserId as string
    let binding: SocketBinding | null = null
    const bucket = createTokenBucket()

    const rateLimited = (ack?: Ack): boolean => {
      if (bucket.take()) return false
      ack?.({ ok: false, error: "Too many call events", code: "CALL_RATE_LIMITED" })
      return true
    }

    /** Drop this socket from a call's fan-out rooms (access-revoke / lease-supersede teardown). */
    const leaveCallRooms = async (bound: SocketBinding): Promise<void> => {
      await socket.leave(callRoom(bound.callId))
      await socket.leave(endpointRoom(bound.callId, bound.endpointId))
    }

    socket.on("call:join", async (payload: unknown, ack?: Ack) => {
      if (rateLimited(ack)) return
      // Availability before Zod (mirrors the REST gate order): the whole-feature
      // switch needs no payload, so it precedes decoding; the per-workspace flag
      // needs workspaceId, so it runs right after the parse and before access.
      if (!cloudflareEnabled) {
        ack?.({ ok: false, error: "Calls media is not configured", code: "CALLS_UNAVAILABLE" })
        return
      }
      const parsed = joinSchema.safeParse(payload)
      if (!parsed.success) {
        ack?.({ ok: false, error: "Invalid call:join payload", code: "VALIDATION_ERROR" })
        return
      }
      const { workspaceId, callId, mediaIncarnation, takeover } = parsed.data
      try {
        await assertWorkspaceCallsEnabled(workspaceId)
        const user = await UserRepository.findByWorkosUserIdInWorkspace(pool, workspaceId, workosUserId)
        if (!user) {
          ack?.({ ok: false, error: "No workspace access", code: "CALL_NOT_PARTICIPANT" })
          return
        }
        const result = await callService.joinCall({
          workspaceId,
          callId,
          userId: user.id,
          takeover,
          mediaIncarnation,
        })

        // A rebind on a live socket (hostile/custom client) must leave the prior
        // call's rooms first, or it keeps receiving that call's roster fan-in.
        if (binding) {
          const prior = binding
          await socket.leave(callRoom(prior.callId))
          await socket.leave(endpointRoom(prior.callId, prior.endpointId))
          // Also leave the prior CALL's domain state: without this the old
          // endpoint/participant stay live until lease reap (~45s), holding call
          // capacity and any DM ring. Best-effort — a failure must not fail the new
          // join, which already succeeded.
          try {
            await callService.leaveCall({
              workspaceId: prior.workspaceId,
              callId: prior.callId,
              userId: prior.userId,
              endpointId: prior.endpointId,
            })
          } catch (err) {
            logger.warn(
              { err, callId: prior.callId, endpointId: prior.endpointId },
              "call rebind: leaving prior call failed"
            )
          }
        }

        binding = {
          workspaceId,
          callId,
          userId: user.id,
          participantId: result.participant.id,
          endpointId: result.endpoint.id,
          epoch: result.endpoint.epoch,
          connectionSeq: result.endpoint.connectionSeq,
          mediaIncarnation,
        }
        await socket.join(callRoom(callId))
        await socket.join(endpointRoom(callId, result.endpoint.id))

        const snapshot = await callService.getRosterSnapshot(workspaceId, callId)
        ack?.({
          ok: true,
          data: {
            endpointId: result.endpoint.id,
            epoch: result.endpoint.epoch,
            rosterVersion: snapshot.rosterVersion,
            roster: snapshot.roster,
            leaseTtlMs: ENDPOINT_LEASE_TTL_MS,
          },
        })
        // Let existing members observe the new arrival.
        broadcastRoster(io, callId, snapshot)
        if (result.supersededEndpointId) notifyEndpointTakenOver(io, callId, result.supersededEndpointId)
      } catch (err) {
        respondError(err, ack, "call:join", { workspaceId, callId })
      }
    })

    socket.on("call:leave", async (_payload: unknown, ack?: Ack) => {
      if (rateLimited(ack)) return
      if (!binding) {
        ack?.({ ok: false, error: "Not joined", code: "CALL_NOT_JOINED" })
        return
      }
      const bound = binding
      try {
        await callService.leaveCall({
          workspaceId: bound.workspaceId,
          callId: bound.callId,
          userId: bound.userId,
          endpointId: bound.endpointId,
        })
        await socket.leave(callRoom(bound.callId))
        await socket.leave(endpointRoom(bound.callId, bound.endpointId))
        binding = null
        const snapshot = await callService.getRosterSnapshot(bound.workspaceId, bound.callId)
        ack?.({ ok: true })
        broadcastRoster(io, bound.callId, snapshot)
      } catch (err) {
        respondError(err, ack, "call:leave", { callId: bound.callId })
      }
    })

    socket.on("call:state", async (payload: unknown, ack?: Ack) => {
      if (rateLimited(ack)) return
      if (!binding) {
        ack?.({ ok: false, error: "Not joined", code: "CALL_NOT_JOINED" })
        return
      }
      const parsed = stateSchema.safeParse(payload)
      if (!parsed.success) {
        ack?.({ ok: false, error: "Invalid call:state payload", code: "VALIDATION_ERROR" })
        return
      }
      const bound = binding
      try {
        const snapshot = await callService.setEndpointMediaState({
          workspaceId: bound.workspaceId,
          callId: bound.callId,
          userId: bound.userId,
          endpointId: bound.endpointId,
          mediaIncarnation: bound.mediaIncarnation,
          mediaState: parsed.data,
        })
        ack?.({ ok: true, data: { rosterVersion: snapshot.rosterVersion } })
        broadcastRoster(io, bound.callId, snapshot)
      } catch (err) {
        respondError(err, ack, "call:state", { callId: bound.callId })
      }
    })

    socket.on("call:lease:renew", async (_payload: unknown, ack?: Ack) => {
      if (rateLimited(ack)) return
      if (!binding) {
        ack?.({ ok: false, error: "Not joined", code: "CALL_NOT_JOINED" })
        return
      }
      const bound = binding
      try {
        // Gate the renew on the kill-switch so flipping calls off drains live
        // calls within one lease TTL rather than letting them run indefinitely.
        await assertWorkspaceCallsEnabled(bound.workspaceId)
        // Re-check host-stream access on every renew: a user kicked from the
        // host stream loses their lease within one TTL and the client tears down.
        const access = await checkCallAccess(pool, {
          workspaceId: bound.workspaceId,
          userId: bound.userId,
          callId: bound.callId,
        })
        if (!access) {
          await leaveCallRooms(bound)
          binding = null
          ack?.({ ok: false, error: "Call access revoked", code: "CALL_ACCESS_REVOKED" })
          return
        }
        const endpoint = await callService.renewEndpointLease({
          workspaceId: bound.workspaceId,
          endpointId: bound.endpointId,
          epoch: bound.epoch,
        })
        if (!endpoint) {
          // A superseded socket must stop receiving roster fan-out: leave both
          // rooms and clear the binding, not merely ack.
          await leaveCallRooms(bound)
          binding = null
          ack?.({ ok: false, error: "Lease superseded", code: "CALL_LEASE_SUPERSEDED" })
          return
        }
        ack?.({ ok: true, data: { leaseExpiresAt: endpoint.leaseExpiresAt.toISOString() } })
      } catch (err) {
        respondError(err, ack, "call:lease:renew", { callId: bound.callId })
      }
    })

    socket.on("disconnect", () => {
      if (!binding) return
      const bound = binding
      binding = null
      // A socket drop is NOT a leave — the lease is the authority. Demote the
      // endpoint to `reconnecting` (fenced on epoch) so a reconnect within the
      // lease re-binds; the sweeper reaps it only if the lease lapses.
      callService
        .markEndpointReconnecting({
          workspaceId: bound.workspaceId,
          endpointId: bound.endpointId,
          epoch: bound.epoch,
          connectionSeq: bound.connectionSeq,
        })
        .then((endpoint) => {
          if (endpoint) return callService.getRosterSnapshot(bound.workspaceId, bound.callId)
          return null
        })
        .then((snapshot) => {
          if (snapshot) broadcastRoster(io, bound.callId, snapshot)
        })
        .catch((err) => {
          logger.warn({ err, callId: bound.callId, endpointId: bound.endpointId }, "call disconnect cleanup failed")
        })
    })
  })
}

function respondError(err: unknown, ack: Ack | undefined, event: string, ctx: Record<string, unknown>): void {
  if (err instanceof HttpError) {
    ack?.({ ok: false, error: err.message, code: err.code })
    return
  }
  logger.error({ err, event, ...ctx }, "Call gateway event failed")
  ack?.({ ok: false, error: "Call event failed", code: "INTERNAL_ERROR" })
}
