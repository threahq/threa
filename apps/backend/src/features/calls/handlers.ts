import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { HttpError } from "../../lib/errors"
import type { WorkspaceSettingsService } from "../workspace-settings"
import { checkCallAccess } from "./access"
import type { CallService } from "./service"
import { broadcastRoster } from "./signaling-gateway"
import { CALL_MODES, PUBLISHED_TRACK_KINDS } from "./config"

const sessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().min(1).max(200_000),
})

const mediaIncarnationSchema = z.string().min(1).max(128)

const startSchema = z.object({
  streamId: z.string().min(1),
  mode: z.enum(CALL_MODES),
  mediaIncarnation: mediaIncarnationSchema.optional(),
})

const cfSessionSchema = z.object({
  mediaIncarnation: mediaIncarnationSchema,
})

const renegotiateSchema = z.object({
  mediaIncarnation: mediaIncarnationSchema,
  sdp: sessionDescriptionSchema,
})

const publishSchema = z.object({
  mediaIncarnation: mediaIncarnationSchema,
  sdp: sessionDescriptionSchema,
  tracks: z
    .array(
      z.object({
        kind: z.enum(PUBLISHED_TRACK_KINDS),
        mid: z.string().min(1).max(64),
        trackName: z.string().min(1).max(128),
      })
    )
    .min(1)
    .max(8),
})

const pullSchema = z.object({
  mediaIncarnation: mediaIncarnationSchema,
  tracks: z
    .array(z.object({ sessionId: z.string().min(1).max(128), trackName: z.string().min(1).max(128) }))
    .min(1)
    .max(64),
})

const closeTracksSchema = z.object({
  mediaIncarnation: mediaIncarnationSchema,
  mids: z.array(z.string().min(1).max(64)).min(1).max(16),
  unpublishKinds: z.array(z.enum(PUBLISHED_TRACK_KINDS)).max(4).optional(),
  sdp: sessionDescriptionSchema.optional(),
})

interface Dependencies {
  pool: Pool
  io: Server
  callService: CallService
  workspaceSettingsService: WorkspaceSettingsService
  /** False when the CF media plane is unconfigured — every calls surface 503s. */
  cloudflareEnabled: boolean
}

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new HttpError("Invalid calls request", {
      status: 400,
      code: "VALIDATION_ERROR",
      details: result.error.flatten(),
    })
  }
  return result.data
}

/**
 * REST + CF-proxy surface for calls. Every endpoint is gated in the same order:
 * CF-config-absent ⇒ 503 CALLS_UNAVAILABLE (the whole feature is off), then the
 * per-workspace flag ⇒ 404-style CALLS_DISABLED (dark feature), then
 * `checkCallAccess` authorization. The proxy endpoints are thin, incarnation-fenced
 * pass-throughs to CF holding the app secret; publish/close additionally update the
 * roster and fan `call:roster` to the `/calls` namespace room.
 */
export function createCallHandlers({
  pool,
  io,
  callService,
  workspaceSettingsService,
  cloudflareEnabled,
}: Dependencies) {
  async function assertAvailable(workspaceId: string): Promise<void> {
    if (!cloudflareEnabled) {
      throw new HttpError("Calls media is not configured", { status: 503, code: "CALLS_UNAVAILABLE" })
    }
    const settings = await workspaceSettingsService.getSettings(workspaceId)
    if (!settings.callsEnabled) {
      throw new HttpError("Calls are not enabled for this workspace", { status: 404, code: "CALLS_DISABLED" })
    }
  }

  async function assertCallAccess(workspaceId: string, userId: string, callId: string): Promise<void> {
    const access = await checkCallAccess(pool, { workspaceId, userId, callId })
    if (!access) {
      throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
    }
  }

  return {
    async start(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      await assertAvailable(workspaceId)
      const body = parseOrThrow(startSchema, req.body)

      const result = await callService.startCall({
        workspaceId,
        streamId: body.streamId,
        userId,
        mode: body.mode,
        mediaIncarnation: body.mediaIncarnation,
      })
      const snapshot = await callService.getRosterSnapshot(workspaceId, result.call.id)

      res.status(result.created ? 201 : 200).json({
        call: result.call,
        created: result.created,
        participant: result.participant,
        endpoint: result.endpoint,
        rosterVersion: snapshot.rosterVersion,
        roster: snapshot.roster,
      })
    },

    async declineInvitation(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { invitationId } = req.params
      await assertAvailable(workspaceId)

      // Scoped to the invitee's own ring — `declineInvitation` CASes on
      // invitee_user_id, so a non-invitee gets the 409 not-actionable, never
      // another user's invitation.
      const invitation = await callService.declineInvitation({ workspaceId, invitationId, userId })
      res.json({ invitation })
    },

    async cancelInvitation(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { invitationId } = req.params
      await assertAvailable(workspaceId)

      // Inviter hang-up before an answer — scoped to the caller's own ring
      // (`cancelInvitation` CASes on inviter_user_id), so a non-inviter gets the
      // 409 not-actionable. Abandonment via leaving the call is handled in the
      // service's leave/reap/grace paths; this is the explicit stop-ringing lever.
      const invitation = await callService.cancelInvitation({ workspaceId, invitationId, userId })
      res.json({ invitation })
    },

    async bootstrap(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { callId } = req.params
      await assertAvailable(workspaceId)
      await assertCallAccess(workspaceId, userId, callId)

      const snapshot = await callService.getRosterSnapshot(workspaceId, callId)
      const self = snapshot.roster.find((entry) => entry.userId === userId) ?? null
      res.json({
        callId,
        rosterVersion: snapshot.rosterVersion,
        roster: snapshot.roster,
        self,
      })
    },

    async createCfSession(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { callId, endpointId } = req.params
      await assertAvailable(workspaceId)
      await assertCallAccess(workspaceId, userId, callId)
      const body = parseOrThrow(cfSessionSchema, req.body)

      const result = await callService.createEndpointCfSession({
        workspaceId,
        callId,
        userId,
        endpointId,
        mediaIncarnation: body.mediaIncarnation,
      })
      res.json(result)
    },

    async renegotiate(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { callId, endpointId } = req.params
      await assertAvailable(workspaceId)
      await assertCallAccess(workspaceId, userId, callId)
      const body = parseOrThrow(renegotiateSchema, req.body)

      const result = await callService.renegotiate({
        workspaceId,
        callId,
        userId,
        endpointId,
        mediaIncarnation: body.mediaIncarnation,
        sdp: body.sdp,
      })
      res.json(result.cf)
    },

    async publishTracks(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { callId, endpointId } = req.params
      await assertAvailable(workspaceId)
      await assertCallAccess(workspaceId, userId, callId)
      const body = parseOrThrow(publishSchema, req.body)

      const result = await callService.publishTracks({
        workspaceId,
        callId,
        userId,
        endpointId,
        mediaIncarnation: body.mediaIncarnation,
        sdp: body.sdp,
        tracks: body.tracks,
      })
      broadcastRoster(io, callId, result.snapshot)
      res.json({ ...result.cf, rosterVersion: result.snapshot.rosterVersion })
    },

    async pullTracks(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { callId, endpointId } = req.params
      await assertAvailable(workspaceId)
      await assertCallAccess(workspaceId, userId, callId)
      const body = parseOrThrow(pullSchema, req.body)

      const result = await callService.pullTracks({
        workspaceId,
        callId,
        userId,
        endpointId,
        mediaIncarnation: body.mediaIncarnation,
        tracks: body.tracks.map((t) => ({
          location: "remote" as const,
          sessionId: t.sessionId,
          trackName: t.trackName,
        })),
      })
      res.json(result.cf)
    },

    async closeTracks(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { callId, endpointId } = req.params
      await assertAvailable(workspaceId)
      await assertCallAccess(workspaceId, userId, callId)
      const body = parseOrThrow(closeTracksSchema, req.body)

      const result = await callService.closeTracks({
        workspaceId,
        callId,
        userId,
        endpointId,
        mediaIncarnation: body.mediaIncarnation,
        mids: body.mids,
        unpublishKinds: body.unpublishKinds,
        sdp: body.sdp,
      })
      if (result.snapshot) broadcastRoster(io, callId, result.snapshot)
      res.json(result.cf)
    },
  }
}
