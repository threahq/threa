import type { Pool, PoolClient } from "pg"
import {
  StreamTypes,
  ActivityTypes,
  AuthorTypes,
  type CallStartedEventPayload,
  type CallEndedEventPayload,
  type Visibility,
  type ActiveCall,
  type StreamActiveCall,
} from "@threa/types"
import { withTransaction, withClient } from "../../db"
import { HttpError } from "../../lib/errors"
import { logger } from "../../lib/logger"
import { callId, callInvitationId, callParticipantId, callEndpointId, eventId } from "../../lib/id"
import { checkStreamAccess, StreamMemberRepository, StreamRepository, StreamEventRepository } from "../streams"
import { UserRepository } from "../workspaces"
import { ActivityRepository } from "../activity"
import { OutboxRepository } from "../../lib/outbox"
import { checkCallAccess } from "./access"
import {
  CallRepository,
  CallInvitationRepository,
  CallParticipantRepository,
  CallEndpointRepository,
  type Call,
  type CallInvitation,
  type CallParticipant,
  type CallEndpoint,
  type CallRosterEntry,
} from "./repository"
import {
  EMPTY_GRACE_MS,
  ENDPOINT_LEASE_TTL_MS,
  INVITATION_TTL_MS,
  CALL_PRODUCT_CAP,
  type CallMode,
  type MediaState,
  type PublishedTrack,
} from "./config"
import {
  CloudflareRealtimeError,
  type RealtimeMediaApi,
  type SessionDescription,
  type LocalTrackRequest,
  type RemoteTrackRequest,
  type TracksResult,
  type RenegotiateResult,
  type CloseTracksResult,
} from "./cloudflare"

export interface StartCallResult {
  call: Call
  created: boolean
  participant: CallParticipant
  endpoint: CallEndpoint
}

export interface JoinCallResult {
  call: Call
  participant: CallParticipant
  endpoint: CallEndpoint
}

/** A versioned roster snapshot: the per-participant rows plus the version they were read at. */
export interface CallRosterSnapshot {
  rosterVersion: number
  roster: CallRosterEntry[]
}

/**
 * Lifecycle owner for calls — the transport-independent state machines (0.1) plus
 * the Cloudflare media-plane proxy (0.2): CF session/track operations run
 * CF-first, then the DB write (INV-41), so no committed row ever claims a
 * `cf_session_id` that was never created. No outbox/timeline emission yet (1.3/1.4).
 * A call is a set of rows in call-scoped tracking tables (INV-57) attached to an
 * existing stream.
 *
 * The service owns every transaction (INV-6) and every transition is CAS +
 * row-lock (INV-20): product glare resolves via `INSERT ... ON CONFLICT DO
 * NOTHING` plus a same-tx re-read; join/leave lock the call row (`FOR UPDATE`)
 * so revive-vs-reap can't write-skew; endpoint leases are fenced on an integer
 * epoch (INV-66).
 *
 * Every state-changing method accepts an optional `tx` so a later PR can splice
 * outbox emission into the same transaction without changing signatures;
 * `withTransaction` treats a passed `PoolClient` as a savepoint.
 */
export class CallService {
  private readonly pool: Pool
  private readonly cloudflare: RealtimeMediaApi | null

  constructor(deps: { pool: Pool; cloudflare?: RealtimeMediaApi | null }) {
    this.pool = deps.pool
    this.cloudflare = deps.cloudflare ?? null
  }

  /** Fail loudly (503) when the CF media plane is not configured (INV-11). */
  private requireCloudflare(): RealtimeMediaApi {
    if (!this.cloudflare) {
      throw new HttpError("Calls media is not configured", { status: 503, code: "CALLS_UNAVAILABLE" })
    }
    return this.cloudflare
  }

  /**
   * Start (or join) the one call on a stream. Product glare resolves in one
   * transaction: insert against the active-per-stream partial index, and on
   * conflict re-read the winner — the response is always "the call you are now
   * in" (`created` distinguishes the two). The creator joins via the *same*
   * locked join path as {@link joinCall} (row lock, grace-revive, capacity,
   * membership, leased endpoint) so a started call is never wedged as a `joined`
   * participant with no lease the sweeper can reap. A DM start rings the peer.
   */
  async startCall(
    params: { workspaceId: string; streamId: string; userId: string; mode: CallMode; mediaIncarnation?: string },
    tx?: PoolClient
  ): Promise<StartCallResult> {
    return withTransaction(tx ?? this.pool, async (client) => {
      const stream = await checkStreamAccess(client, params.streamId, params.workspaceId, params.userId)
      if (!stream) {
        throw new HttpError("No access to this stream", { status: 403, code: "CALL_STREAM_ACCESS_DENIED" })
      }

      const inserted = await CallRepository.insertIfNoActiveCall(client, {
        id: callId(),
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        startedBy: params.userId,
        mode: params.mode,
        mediaTransport: "sfu",
      })

      let targetCallId: string
      let created: boolean
      if (inserted) {
        targetCallId = inserted.id
        created = true
      } else {
        const existing = await CallRepository.findOpenByStream(client, params.workspaceId, params.streamId)
        if (!existing) {
          throw new HttpError("Call start conflicted", { status: 409, code: "CALL_START_CONFLICT" })
        }
        targetCallId = existing.id
        created = false
      }

      const admitted = await this.joinLockedCall(client, {
        workspaceId: params.workspaceId,
        callId: targetCallId,
        userId: params.userId,
        mediaIncarnation: params.mediaIncarnation,
      })

      // A newly created call is a slotted broadcast row on the host stream
      // (INV-4/7): append it in the SAME transaction as the call insert so every
      // member sees the live card and it survives reload. A join onto an existing
      // call adds no row (the card already exists) — only the roster changes.
      if (created) {
        await this.appendCallStarted(client, {
          call: admitted.call,
          streamId: params.streamId,
          streamVisibility: stream.visibility,
          startedBy: params.userId,
        })
      }

      if (created && stream.type === StreamTypes.DM) {
        const peerId = await this.findDmPeer(client, params.streamId, params.userId)
        if (peerId) {
          const invitation = await CallInvitationRepository.insertRinging(client, {
            id: callInvitationId(),
            workspaceId: params.workspaceId,
            callId: targetCallId,
            inviteeUserId: peerId,
            inviterUserId: params.userId,
            expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          })
          // Ring reaches the invitee (INV-4): user-scoped to their room so every
          // device rings off one attempt id. Same tx as the invitation insert.
          const inviter = await UserRepository.findById(client, params.workspaceId, params.userId)
          await OutboxRepository.insert(client, "call:invitation_created", {
            workspaceId: params.workspaceId,
            targetUserId: peerId,
            attemptId: invitation.id,
            callId: targetCallId,
            streamId: params.streamId,
            inviter: { id: params.userId, name: inviter?.name ?? null },
            mode: params.mode,
            expiresAt: invitation.expiresAt.toISOString(),
          })
        }
      }

      return { call: admitted.call, created, participant: admitted.participant, endpoint: admitted.endpoint }
    })
  }

  /**
   * Admit a device/tab session to a call. Verifies call access, then routes
   * through the shared locked join path: lock the call row, revive it out of
   * grace if needed, enforce the product cap, admit membership
   * (actor-conditional — a removed participant is rejected), and admit exactly
   * one live endpoint (a second live device is rejected unless `takeover`, which
   * closes the prior one and mints a higher epoch). Any live ring for this user
   * is accepted.
   */
  async joinCall(
    params: { workspaceId: string; callId: string; userId: string; takeover?: boolean; mediaIncarnation?: string },
    tx?: PoolClient
  ): Promise<JoinCallResult> {
    return withTransaction(tx ?? this.pool, async (client) => {
      const access = await checkCallAccess(client, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        callId: params.callId,
      })
      if (!access) {
        throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
      }

      return this.joinLockedCall(client, params)
    })
  }

  /**
   * The single locked-join transition shared by {@link startCall} and
   * {@link joinCall}: lock the call row (serializes revive-vs-reap), reject an
   * ended call, revive from grace, enforce the cap, admit membership, and mint
   * exactly one leased endpoint (epoch = prior max + 1). Because the creator
   * takes this same path, every `joined` participant owns a lease the reaper can
   * expire — a started-but-never-media-connected call cannot wedge the stream's
   * active-call slot forever. Caller must already hold call/stream access.
   */
  private async joinLockedCall(
    client: PoolClient,
    params: { workspaceId: string; callId: string; userId: string; takeover?: boolean; mediaIncarnation?: string }
  ): Promise<JoinCallResult> {
    let call = await CallRepository.findByIdForUpdate(client, params.workspaceId, params.callId)
    if (!call) {
      throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
    }
    if (call.status === "ended") {
      throw new HttpError("Call has ended", { status: 409, code: "CALL_ENDED" })
    }
    if (call.status === "empty_grace") {
      call = (await CallRepository.reviveFromGrace(client, params.workspaceId, params.callId)) ?? call
    }

    const others = await CallParticipantRepository.countJoined(client, params.workspaceId, params.callId, {
      excludeUserId: params.userId,
    })
    if (others >= CALL_PRODUCT_CAP) {
      throw new HttpError("Call is full", { status: 409, code: "CALL_FULL" })
    }

    const participant = await this.admitParticipant(client, { call, userId: params.userId, invitedBy: null })

    const incarnation = params.mediaIncarnation ?? null
    const live = await CallEndpointRepository.findLiveByParticipant(client, params.workspaceId, participant.id)
    const endpoint = await this.admitEndpoint(client, { params, participant, live, incarnation })

    const accepted = await CallInvitationRepository.acceptRingingForUser(client, {
      workspaceId: params.workspaceId,
      callId: params.callId,
      inviteeUserId: params.userId,
    })
    // Settle the invitee's ring across their other devices (accept on the phone
    // clears the laptop) and cancel the ring push. No-op for the creator's own
    // join (they are the inviter, never an invitee here).
    for (const invitation of accepted) {
      await this.emitSettled(client, invitation, "accepted")
    }

    // A join is a membership change: bump the roster version in the same tx as
    // the membership/endpoint writes so the snapshot the gateway reads after
    // commit is strictly newer than what peers hold (INV-66).
    await CallRepository.bumpRosterVersion(client, params.workspaceId, params.callId)
    await this.emitParticipantsChanged(client, params.workspaceId, call.streamId, params.callId)

    return { call, participant, endpoint }
  }

  /**
   * Admit exactly one live endpoint for a participant, resolving the
   * device/tab/reload arbitration. The lease is the authority (INV — a lapsed
   * lease is the only durable "gone" signal), so:
   * - No live endpoint ⇒ mint a fresh one (epoch = prior max + 1).
   * - A live endpoint that is `reconnecting`, carries no incarnation yet (a REST
   *   start not yet socket-bound), or carries THIS incarnation ⇒ re-bind that
   *   same row + epoch to the incoming incarnation (a transient socket drop or a
   *   reload within the lease returns to the same endpoint, fresh CF session).
   * - A genuinely live (`connected`) endpoint on a DIFFERENT incarnation ⇒ a
   *   second concurrent device: rejected unless `takeover`, which closes the
   *   prior one and mints a higher epoch.
   */
  private async admitEndpoint(
    client: PoolClient,
    args: {
      params: { workspaceId: string; callId: string; takeover?: boolean }
      participant: CallParticipant
      live: CallEndpoint | null
      incarnation: string | null
    }
  ): Promise<CallEndpoint> {
    const { params, participant, live, incarnation } = args
    const leaseExpiresAt = new Date(Date.now() + ENDPOINT_LEASE_TTL_MS)

    if (live) {
      // Rebind only applies to the incarnation-aware socket-join path. A caller
      // that supplies no incarnation keeps the transport-independent rule:
      // a live endpoint blocks a second one unless takeover.
      const rebindable =
        incarnation !== null &&
        (live.status === "reconnecting" || live.mediaIncarnation === null || live.mediaIncarnation === incarnation)
      if (rebindable) {
        const rebound = await CallEndpointRepository.rebind(client, {
          workspaceId: params.workspaceId,
          id: live.id,
          mediaIncarnation: incarnation,
          leaseExpiresAt,
        })
        if (rebound) return rebound
        // Lost the row to a concurrent close between read and CAS; fall through to a fresh mint.
      } else if (!params.takeover) {
        throw new HttpError("An active endpoint already exists for this user", {
          status: 409,
          code: "CALL_ENDPOINT_ACTIVE",
        })
      } else {
        await CallEndpointRepository.close(client, params.workspaceId, live.id)
      }
    }

    const maxEpoch = await CallEndpointRepository.maxEpochForParticipant(client, params.workspaceId, participant.id)
    return CallEndpointRepository.insert(client, {
      id: callEndpointId(),
      workspaceId: params.workspaceId,
      callId: params.callId,
      participantId: participant.id,
      epoch: maxEpoch + 1,
      mediaIncarnation: incarnation,
      leaseExpiresAt,
    })
  }

  /**
   * Close one endpoint. The participant goes `left` once no live endpoint
   * remains; when the last joined participant leaves, the call enters
   * `empty_grace` under the call row lock (reason `completed`).
   */
  async leaveCall(
    params: { workspaceId: string; callId: string; userId: string; endpointId: string },
    tx?: PoolClient
  ): Promise<{ call: Call }> {
    return withTransaction(tx ?? this.pool, async (client) => {
      const call = await CallRepository.findByIdForUpdate(client, params.workspaceId, params.callId)
      if (!call) {
        throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
      }

      const endpoint = await CallEndpointRepository.findById(client, params.workspaceId, params.endpointId)
      if (!endpoint || endpoint.callId !== params.callId) {
        throw new HttpError("Endpoint not found on this call", { status: 404, code: "CALL_ENDPOINT_NOT_FOUND" })
      }
      const participant = await CallParticipantRepository.findByUser(
        client,
        params.workspaceId,
        params.callId,
        params.userId
      )
      if (!participant || endpoint.participantId !== participant.id) {
        throw new HttpError("Endpoint does not belong to this participant", {
          status: 403,
          code: "CALL_NOT_PARTICIPANT",
        })
      }

      await CallEndpointRepository.close(client, params.workspaceId, params.endpointId)
      await CallParticipantRepository.markLeftIfNoLiveEndpoint(client, {
        workspaceId: params.workspaceId,
        callId: params.callId,
        userId: params.userId,
      })

      const joined = await CallParticipantRepository.countJoined(client, params.workspaceId, params.callId)
      if (joined === 0 && call.status === "active") {
        await CallRepository.enterGraceIfEmpty(client, {
          workspaceId: params.workspaceId,
          id: params.callId,
          graceDeadline: new Date(Date.now() + EMPTY_GRACE_MS),
          reason: "completed",
        })
        // The call is now empty: retract every outstanding ring in the same tx
        // (INV-7). Cancelling (not letting it lapse) is what prevents a
        // missed-call activity for a caller who hung up before an answer.
        const cancelled = await CallInvitationRepository.cancelRingingForCall(client, {
          workspaceId: params.workspaceId,
          callId: params.callId,
        })
        await this.settleCancelledRings(client, cancelled)
      } else {
        // The call lives on, but the leaving user's own outgoing ring is
        // abandoned (a DM inviter hanging up while a group call continues).
        const cancelled = await CallInvitationRepository.cancelRingingByInviter(client, {
          workspaceId: params.workspaceId,
          callId: params.callId,
          inviterUserId: params.userId,
        })
        await this.settleCancelledRings(client, cancelled)
      }

      // A leave is a membership change: bump the roster version in the same tx as
      // the endpoint-close/participant-left writes (INV-66).
      await CallRepository.bumpRosterVersion(client, params.workspaceId, params.callId)
      await this.emitParticipantsChanged(client, params.workspaceId, call.streamId, params.callId)

      const updated = (await CallRepository.findById(client, params.workspaceId, params.callId)) ?? call
      return { call: updated }
    })
  }

  /**
   * Leave a call as the given user, closing ALL their live endpoints at once —
   * the rejoin bar's "Leave" after a fresh page load, where the client holds no
   * endpoint id (a prior incarnation's lease still keeps the participant `joined`,
   * and dismissing without leaving would leave a 45s zombie). Idempotent: a user
   * with no participant row is a no-op. Same emptiness→grace + ring-retraction +
   * roster-fanout tail as {@link leaveCall}.
   */
  async leaveCallAsUser(
    params: { workspaceId: string; callId: string; userId: string },
    tx?: PoolClient
  ): Promise<{ call: Call }> {
    return withTransaction(tx ?? this.pool, async (client) => {
      const call = await CallRepository.findByIdForUpdate(client, params.workspaceId, params.callId)
      if (!call) {
        throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
      }
      const participant = await CallParticipantRepository.findByUser(
        client,
        params.workspaceId,
        params.callId,
        params.userId
      )
      if (!participant) {
        return { call }
      }

      await CallEndpointRepository.closeByParticipant(client, params.workspaceId, participant.id)
      await CallParticipantRepository.markLeftIfNoLiveEndpoint(client, {
        workspaceId: params.workspaceId,
        callId: params.callId,
        userId: params.userId,
      })

      const joined = await CallParticipantRepository.countJoined(client, params.workspaceId, params.callId)
      if (joined === 0 && call.status === "active") {
        await CallRepository.enterGraceIfEmpty(client, {
          workspaceId: params.workspaceId,
          id: params.callId,
          graceDeadline: new Date(Date.now() + EMPTY_GRACE_MS),
          reason: "completed",
        })
        const cancelled = await CallInvitationRepository.cancelRingingForCall(client, {
          workspaceId: params.workspaceId,
          callId: params.callId,
        })
        await this.settleCancelledRings(client, cancelled)
      } else {
        const cancelled = await CallInvitationRepository.cancelRingingByInviter(client, {
          workspaceId: params.workspaceId,
          callId: params.callId,
          inviterUserId: params.userId,
        })
        await this.settleCancelledRings(client, cancelled)
      }

      await CallRepository.bumpRosterVersion(client, params.workspaceId, params.callId)
      await this.emitParticipantsChanged(client, params.workspaceId, call.streamId, params.callId)

      const updated = (await CallRepository.findById(client, params.workspaceId, params.callId)) ?? call
      return { call: updated }
    })
  }

  /** Decline a live ring (`ringing → declined`); only the invitee may decline. */
  async declineInvitation(
    params: { workspaceId: string; invitationId: string; userId: string },
    tx?: PoolClient
  ): Promise<CallInvitation> {
    return withTransaction(tx ?? this.pool, async (client) => {
      const declined = await CallInvitationRepository.decline(client, {
        workspaceId: params.workspaceId,
        id: params.invitationId,
        inviteeUserId: params.userId,
      })
      if (!declined) {
        throw new HttpError("Invitation is not ringing", { status: 409, code: "CALL_INVITATION_NOT_ACTIONABLE" })
      }
      await this.emitSettled(client, declined, "declined")
      return declined
    })
  }

  /** Cancel a live ring (`ringing → cancelled`); only the inviter may cancel. */
  async cancelInvitation(
    params: { workspaceId: string; invitationId: string; userId: string },
    tx?: PoolClient
  ): Promise<CallInvitation> {
    return withTransaction(tx ?? this.pool, async (client) => {
      const cancelled = await CallInvitationRepository.cancel(client, {
        workspaceId: params.workspaceId,
        id: params.invitationId,
        inviterUserId: params.userId,
      })
      if (!cancelled) {
        throw new HttpError("Invitation is not ringing", { status: 409, code: "CALL_INVITATION_NOT_ACTIONABLE" })
      }
      await this.emitSettled(client, cancelled, "cancelled")
      return cancelled
    })
  }

  /**
   * User-scoped settle broadcast to the invitee (INV-4): clears the overlay on
   * every device and cancels the ring push. Emitted in the caller's transaction
   * on every terminal ring CAS (accept, decline, cancel, expire).
   */
  private async emitSettled(
    client: PoolClient,
    invitation: CallInvitation,
    outcome: "accepted" | "declined" | "cancelled" | "expired" | "superseded"
  ): Promise<void> {
    // Carry the inviter name so the SW's offline "Call ended" fallback can name
    // the caller when the cancel push collapsed a ring that was never shown.
    const inviter = await UserRepository.findById(client, invitation.workspaceId, invitation.inviterUserId)
    await OutboxRepository.insert(client, "call:invitation_settled", {
      workspaceId: invitation.workspaceId,
      targetUserId: invitation.inviteeUserId,
      attemptId: invitation.id,
      callId: invitation.callId,
      outcome,
      inviterName: inviter?.name ?? null,
    })
  }

  /** Cancel the given outstanding rings (`ringing → cancelled` already applied) and settle each. */
  private async settleCancelledRings(client: PoolClient, invitations: CallInvitation[]): Promise<void> {
    for (const invitation of invitations) {
      await this.emitSettled(client, invitation, "cancelled")
    }
  }

  /**
   * Fenced lease renewal (INV-20/66): a single UPDATE guarded on
   * `(id, epoch, live status)`. A stale epoch renews nothing and returns `null`
   * — not an error, the caller's incarnation was already superseded. Single
   * query, so the querier is passed straight through (INV-30).
   */
  async renewEndpointLease(
    params: { workspaceId: string; endpointId: string; epoch: number },
    tx?: PoolClient
  ): Promise<CallEndpoint | null> {
    return CallEndpointRepository.renewLease(tx ?? this.pool, {
      workspaceId: params.workspaceId,
      id: params.endpointId,
      epoch: params.epoch,
      leaseExpiresAt: new Date(Date.now() + ENDPOINT_LEASE_TTL_MS),
    })
  }

  /**
   * Mark a disconnected endpoint `reconnecting` (fenced on epoch +
   * `connection_seq`). The lease still holds the slot, so a reconnect within it
   * re-binds — a socket drop is NOT a leave. `null` when the fence is stale: a
   * superseded instance's disconnect, or a fast same-incarnation reconnect that
   * already re-bound the endpoint (bumping `connection_seq`) before this demotion
   * lands. Either way the live endpoint must not be demoted.
   */
  async markEndpointReconnecting(params: {
    workspaceId: string
    endpointId: string
    epoch: number
    connectionSeq: number
  }): Promise<CallEndpoint | null> {
    return withTransaction(this.pool, async (client) => {
      const endpoint = await CallEndpointRepository.markReconnecting(client, {
        workspaceId: params.workspaceId,
        id: params.endpointId,
        epoch: params.epoch,
        connectionSeq: params.connectionSeq,
      })
      // A connection transition (connected → reconnecting) changes the roster:
      // bump the version in the same tx so the disconnect broadcast is newer than
      // what peers hold (INV-66). Skip the bump when nothing was demoted (stale epoch).
      if (endpoint) {
        await CallRepository.bumpRosterVersion(client, params.workspaceId, endpoint.callId)
      }
      return endpoint
    })
  }

  /**
   * The one live call on a stream, projected for the stream bootstrap's
   * `activeCall` (INV-53 pair for the timeline card's live state + the reload
   * rejoin bar). `selfLiveParticipant` is true when the viewer holds a `joined`
   * participant row with a live endpoint — the rejoin-bar trigger. Caller has
   * already validated stream access, so this is a plain read (INV-30).
   */
  async getStreamActiveCall(params: {
    workspaceId: string
    streamId: string
    userId: string
  }): Promise<StreamActiveCall | null> {
    return withClient(this.pool, async (client) => {
      const call = await CallRepository.findOpenByStream(client, params.workspaceId, params.streamId)
      if (!call) return null
      const roster = await CallParticipantRepository.listRoster(client, params.workspaceId, call.id)
      return {
        callId: call.id,
        mode: call.mode,
        participantCount: roster.length,
        participantUserIds: roster.map((r) => r.userId),
        selfLiveParticipant: roster.some((r) => r.userId === params.userId && r.endpointId !== null),
      }
    })
  }

  /**
   * Live calls across the viewer's accessible streams, for the workspace
   * bootstrap's `activeCalls` sidebar-dot seed. `accessibleStreamIds` is the
   * viewer's access-filtered stream set (INV-62 enforced by the caller). Calls
   * only exist on non-thread roots today, so `rootStreamId` equals `streamId`.
   */
  async listWorkspaceActiveCalls(params: {
    workspaceId: string
    accessibleStreamIds: string[]
  }): Promise<ActiveCall[]> {
    const rows = await CallRepository.listActiveByStreamIds(this.pool, params.workspaceId, params.accessibleStreamIds)
    return rows.map((row) => ({
      callId: row.callId,
      streamId: row.streamId,
      rootStreamId: row.streamId,
      mode: row.mode,
      participantCount: row.participantCount,
    }))
  }

  /** Read the versioned roster snapshot (call.roster_version + per-participant rows) on one connection. */
  async getRosterSnapshot(workspaceId: string, targetCallId: string): Promise<CallRosterSnapshot> {
    return withClient(this.pool, async (client) => {
      const call = await CallRepository.findById(client, workspaceId, targetCallId)
      if (!call) {
        throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
      }
      const roster = await CallParticipantRepository.listRoster(client, workspaceId, targetCallId)
      return { rosterVersion: call.rosterVersion, roster }
    })
  }

  /**
   * Update the server-owned media state (mute/camera claims) for an endpoint,
   * bump the roster version, and return the fresh snapshot. Camera-enable is
   * rejected on an audio-only call (the mode is immutable and caps the media).
   */
  async setEndpointMediaState(params: {
    workspaceId: string
    callId: string
    userId: string
    endpointId: string
    mediaIncarnation: string
    mediaState: MediaState
  }): Promise<CallRosterSnapshot> {
    return withTransaction(this.pool, async (client) => {
      const { endpoint, call } = await this.loadFencedEndpoint(client, params)
      if (params.mediaState.cameraOn === true && call.mode === "audio_only") {
        throw new HttpError("Camera is not allowed on an audio-only call", {
          status: 409,
          code: "CALL_CAMERA_NOT_ALLOWED",
        })
      }
      const merged: MediaState = { ...endpoint.mediaState, ...params.mediaState }
      await CallEndpointRepository.setMediaState(client, {
        workspaceId: params.workspaceId,
        id: endpoint.id,
        mediaState: merged,
      })
      const rosterVersion = await CallRepository.bumpRosterVersion(client, params.workspaceId, params.callId)
      const roster = await CallParticipantRepository.listRoster(client, params.workspaceId, params.callId)
      return { rosterVersion: rosterVersion ?? call.rosterVersion, roster }
    })
  }

  /**
   * Create the endpoint's CF session (INV-41: CF call BEFORE the DB write, never
   * inside a transaction). Fenced on `(endpointId, media_incarnation)`. Idempotent
   * per incarnation: an endpoint that already carries a `cf_session_id` returns it
   * without a second CF call. On the CAS losing to a concurrent writer or a stale
   * incarnation, the just-created CF session is closed best-effort so nothing
   * strands.
   */
  async createEndpointCfSession(params: {
    workspaceId: string
    callId: string
    userId: string
    endpointId: string
    mediaIncarnation: string
  }): Promise<{ cfSessionId: string; sessionDescription?: SessionDescription; idempotent: boolean }> {
    const cf = this.requireCloudflare()
    const { endpoint } = await this.fenceEndpoint(params)
    if (endpoint.cfSessionId) {
      return { cfSessionId: endpoint.cfSessionId, idempotent: true }
    }

    const created = await this.cfCall(() => cf.createSession())

    let bound: CallEndpoint | null
    try {
      bound = await CallEndpointRepository.setCfSessionIfUnset(this.pool, {
        workspaceId: params.workspaceId,
        id: params.endpointId,
        mediaIncarnation: params.mediaIncarnation,
        cfSessionId: created.sessionId,
      })
    } catch (err) {
      // The CAS write failed (e.g. a transient DB drop) after the CF session was
      // minted — no row captured it, so close it best-effort before rethrowing so
      // nothing strands until CF's inactivity timeout.
      await this.bestEffortCloseSession(created.sessionId)
      throw err
    }
    if (bound) {
      return { cfSessionId: created.sessionId, sessionDescription: created.sessionDescription, idempotent: false }
    }

    // CAS failed: either another call bound a session for this incarnation
    // (idempotent winner) or the endpoint/incarnation is no longer live. Either
    // way the session we just minted is orphaned — close it best-effort.
    await this.bestEffortCloseSession(created.sessionId)
    const current = await CallEndpointRepository.findById(this.pool, params.workspaceId, params.endpointId)
    if (current && current.cfSessionId && current.mediaIncarnation === params.mediaIncarnation) {
      return { cfSessionId: current.cfSessionId, idempotent: true }
    }
    throw new HttpError("Endpoint incarnation is stale", { status: 409, code: "CALL_STALE_INCARNATION" })
  }

  /**
   * Publish local tracks: CF `addLocalTracks` (outside any tx), then overwrite the
   * endpoint's published-track registry to the declared set, bump the roster
   * version, and return the CF answer plus the fresh snapshot. Peers pull these
   * tracks on the roster change (CF pushes no notification).
   */
  async publishTracks(params: {
    workspaceId: string
    callId: string
    userId: string
    endpointId: string
    mediaIncarnation: string
    sdp: SessionDescription
    tracks: Array<{ kind: PublishedTrack["kind"]; mid: string; trackName: string }>
  }): Promise<{ cf: TracksResult; snapshot: CallRosterSnapshot }> {
    const cf = this.requireCloudflare()
    const { endpoint } = await this.fenceEndpoint(params)
    const cfSessionId = this.requireCfSession(endpoint)

    const localTracks: LocalTrackRequest[] = params.tracks.map((t) => ({
      location: "local",
      trackName: t.trackName,
      mid: t.mid,
    }))
    const cfResult = await this.cfCall(() => cf.addLocalTracks(cfSessionId, { sdp: params.sdp, tracks: localTracks }))

    const registry: PublishedTrack[] = params.tracks.map((t) => ({ kind: t.kind, trackName: t.trackName }))
    const snapshot = await withTransaction(this.pool, async (client) => {
      const updated = await CallEndpointRepository.setPublishedTracks(client, {
        workspaceId: params.workspaceId,
        id: params.endpointId,
        publishedTracks: registry,
      })
      if (!updated) {
        // The endpoint was closed (concurrent takeover/reap) between the fence read
        // and this write — don't bump the roster for a registry that wasn't persisted.
        throw new HttpError("Endpoint is no longer live", { status: 409, code: "CALL_ENDPOINT_NOT_LIVE" })
      }
      const rosterVersion = await CallRepository.bumpRosterVersion(client, params.workspaceId, params.callId)
      const roster = await CallParticipantRepository.listRoster(client, params.workspaceId, params.callId)
      return { rosterVersion: rosterVersion ?? 0, roster }
    })
    return { cf: cfResult, snapshot }
  }

  /** Pull peer tracks: a thin CF `tracks/new` (remote) pass-through, incarnation-fenced. No DB write. */
  async pullTracks(params: {
    workspaceId: string
    callId: string
    userId: string
    endpointId: string
    mediaIncarnation: string
    tracks: RemoteTrackRequest[]
  }): Promise<{ cf: TracksResult }> {
    const cf = this.requireCloudflare()
    const { endpoint } = await this.fenceEndpoint(params)
    const cfSessionId = this.requireCfSession(endpoint)
    const cfResult = await this.cfCall(() => cf.pullRemoteTracks(cfSessionId, { tracks: params.tracks }))
    return { cf: cfResult }
  }

  /** Renegotiate the CF session: a thin pass-through, incarnation-fenced. No DB write. */
  async renegotiate(params: {
    workspaceId: string
    callId: string
    userId: string
    endpointId: string
    mediaIncarnation: string
    sdp: SessionDescription
  }): Promise<{ cf: RenegotiateResult }> {
    const cf = this.requireCloudflare()
    const { endpoint } = await this.fenceEndpoint(params)
    const cfSessionId = this.requireCfSession(endpoint)
    const cfResult = await this.cfCall(() => cf.renegotiateSession(cfSessionId, params.sdp))
    return { cf: cfResult }
  }

  /**
   * Close published tracks: CF `tracks/close` (outside any tx). When the caller
   * names the kinds it is unpublishing, prune them from the registry, bump the
   * roster, and return the fresh snapshot so peers stop pulling dead tracks.
   */
  async closeTracks(params: {
    workspaceId: string
    callId: string
    userId: string
    endpointId: string
    mediaIncarnation: string
    mids: string[]
    unpublishKinds?: Array<PublishedTrack["kind"]>
    sdp?: SessionDescription
  }): Promise<{ cf: CloseTracksResult; snapshot?: CallRosterSnapshot }> {
    const cf = this.requireCloudflare()
    const { endpoint } = await this.fenceEndpoint(params)
    const cfSessionId = this.requireCfSession(endpoint)
    const cfResult = await this.cfCall(() =>
      cf.closeTracks(cfSessionId, { mids: params.mids, force: false, sdp: params.sdp })
    )

    if (!params.unpublishKinds || params.unpublishKinds.length === 0) {
      return { cf: cfResult }
    }
    const remove = new Set(params.unpublishKinds)
    const registry = endpoint.publishedTracks.filter((t) => !remove.has(t.kind))
    const snapshot = await withTransaction(this.pool, async (client) => {
      const updated = await CallEndpointRepository.setPublishedTracks(client, {
        workspaceId: params.workspaceId,
        id: params.endpointId,
        publishedTracks: registry,
      })
      if (!updated) {
        // The endpoint was closed concurrently — skip the bump for an unpersisted registry.
        throw new HttpError("Endpoint is no longer live", { status: 409, code: "CALL_ENDPOINT_NOT_LIVE" })
      }
      const rosterVersion = await CallRepository.bumpRosterVersion(client, params.workspaceId, params.callId)
      const roster = await CallParticipantRepository.listRoster(client, params.workspaceId, params.callId)
      return { rosterVersion: rosterVersion ?? 0, roster }
    })
    return { cf: cfResult, snapshot }
  }

  /** Run a CF call, translating a transport/CF error into a surfaced HttpError (502/504). */
  private async cfCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof CloudflareRealtimeError) {
        const status = err.code === "CF_TIMEOUT" ? 504 : 502
        throw new HttpError("Calls media provider error", {
          status,
          code: "CALL_MEDIA_PROVIDER_ERROR",
          details: { cfCode: err.code, cfErrorCode: err.cfErrorCode },
        })
      }
      throw err
    }
  }

  private requireCfSession(endpoint: CallEndpoint): string {
    if (!endpoint.cfSessionId) {
      throw new HttpError("Endpoint has no CF session yet", { status: 409, code: "CALL_NO_CF_SESSION" })
    }
    return endpoint.cfSessionId
  }

  private async bestEffortCloseSession(sessionId: string): Promise<void> {
    if (!this.cloudflare) return
    try {
      await this.cloudflare.closeSession(sessionId)
    } catch (err) {
      logger.warn({ err, sessionId }, "Best-effort CF session close failed")
    }
  }

  /**
   * Ownership + incarnation fence for a proxy call, run on the pool WITHOUT a
   * transaction (the CF call that follows must not hold a DB connection, INV-41).
   * Verifies the endpoint is on this call, belongs to this user, is live, and
   * carries the claimed incarnation; a mismatch is a stale incarnation (409).
   */
  private async fenceEndpoint(params: {
    workspaceId: string
    callId: string
    userId: string
    endpointId: string
    mediaIncarnation: string
  }): Promise<{ endpoint: CallEndpoint; call: Call }> {
    return withClient(this.pool, (client) => this.loadFencedEndpoint(client, params))
  }

  private async loadFencedEndpoint(
    client: PoolClient,
    params: { workspaceId: string; callId: string; userId: string; endpointId: string; mediaIncarnation: string }
  ): Promise<{ endpoint: CallEndpoint; call: Call }> {
    const call = await CallRepository.findById(client, params.workspaceId, params.callId)
    if (!call) {
      throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
    }
    const endpoint = await CallEndpointRepository.findById(client, params.workspaceId, params.endpointId)
    if (!endpoint || endpoint.callId !== params.callId) {
      throw new HttpError("Endpoint not found on this call", { status: 404, code: "CALL_ENDPOINT_NOT_FOUND" })
    }
    const participant = await CallParticipantRepository.findByUser(
      client,
      params.workspaceId,
      params.callId,
      params.userId
    )
    if (!participant || endpoint.participantId !== participant.id) {
      throw new HttpError("Endpoint does not belong to this participant", {
        status: 403,
        code: "CALL_NOT_PARTICIPANT",
      })
    }
    if (endpoint.status === "closed") {
      throw new HttpError("Endpoint is no longer live", { status: 409, code: "CALL_ENDPOINT_NOT_LIVE" })
    }
    if (endpoint.mediaIncarnation !== params.mediaIncarnation) {
      throw new HttpError("Endpoint incarnation is stale", { status: 409, code: "CALL_STALE_INCARNATION" })
    }
    return { endpoint, call }
  }

  /**
   * Remove a participant. The remover must be a joined participant; the target
   * goes `removed` (recording `removed_by`) and their endpoints close. If the
   * call is thereby empty it enters `empty_grace` under the call row lock.
   */
  async removeParticipant(
    params: { workspaceId: string; callId: string; byUserId: string; targetUserId: string },
    tx?: PoolClient
  ): Promise<CallParticipant> {
    return withTransaction(tx ?? this.pool, async (client) => {
      const call = await CallRepository.findByIdForUpdate(client, params.workspaceId, params.callId)
      if (!call) {
        throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
      }

      const remover = await CallParticipantRepository.findByUser(
        client,
        params.workspaceId,
        params.callId,
        params.byUserId
      )
      if (!remover || remover.status !== "joined") {
        throw new HttpError("Only a joined participant can remove others", {
          status: 403,
          code: "CALL_NOT_PARTICIPANT",
        })
      }

      const removed = await CallParticipantRepository.remove(client, {
        workspaceId: params.workspaceId,
        callId: params.callId,
        targetUserId: params.targetUserId,
        removedBy: params.byUserId,
      })
      if (!removed) {
        throw new HttpError("Participant not found", { status: 404, code: "CALL_PARTICIPANT_NOT_FOUND" })
      }

      await CallEndpointRepository.closeByParticipant(client, params.workspaceId, removed.id)

      const joined = await CallParticipantRepository.countJoined(client, params.workspaceId, params.callId)
      if (joined === 0 && call.status === "active") {
        await CallRepository.enterGraceIfEmpty(client, {
          workspaceId: params.workspaceId,
          id: params.callId,
          graceDeadline: new Date(Date.now() + EMPTY_GRACE_MS),
          reason: "completed",
        })
      }

      // Removal is a membership change: bump the roster version in the same tx as
      // the participant-removed/endpoint-close writes (INV-66).
      await CallRepository.bumpRosterVersion(client, params.workspaceId, params.callId)
      await this.emitParticipantsChanged(client, params.workspaceId, call.streamId, params.callId)

      return removed
    })
  }

  /**
   * Sweep: expire `ringing` invitations past their deadline. Each expiry, in the
   * same transaction (INV-7): settle the invitee's ring across their devices and
   * cancel the ring push (`call:invitation_settled` outcome `expired`), and land
   * a missed-call activity row for the invitee whose `activity:created` the push
   * handler then delivers under the invitee's normal notification preferences
   * (structured payload — the frontend formats it, INV-46). Returns the count.
   */
  async expireStaleRings(now: Date = new Date()): Promise<{ expired: number }> {
    return withTransaction(this.pool, async (client) => {
      const expired = await CallInvitationRepository.expireStaleRings(client, now)
      for (const invitation of expired) {
        await this.emitSettled(client, invitation, "expired")
        await this.recordMissedCall(client, invitation)
      }
      return { expired: expired.length }
    })
  }

  /**
   * Insert the missed-call activity row for the invitee of an expired ring and
   * emit its `activity:created` (with the invitee's absolute unread counts, sync
   * phase 2c) so the badge and push land the same way a mention or DM message
   * would. The call row supplies the host stream and mode; a missing call/inviter
   * degrades to a row without those context fields rather than skipping the miss.
   */
  private async recordMissedCall(client: PoolClient, invitation: CallInvitation): Promise<void> {
    const call = await CallRepository.findById(client, invitation.workspaceId, invitation.callId)
    if (!call) return
    const inviter = await UserRepository.findById(client, invitation.workspaceId, invitation.inviterUserId)
    const stream = await StreamRepository.findById(client, call.streamId)
    const context = {
      authorName: inviter?.name ?? null,
      streamName: stream?.displayName ?? stream?.slug ?? null,
      callId: invitation.callId,
      mode: call.mode,
    }
    const activity = await ActivityRepository.insert(client, {
      workspaceId: invitation.workspaceId,
      userId: invitation.inviteeUserId,
      activityType: ActivityTypes.MISSED_CALL,
      streamId: call.streamId,
      messageId: null,
      actorId: invitation.inviterUserId,
      actorType: AuthorTypes.USER,
      context,
    })
    if (!activity) return
    const counts = await ActivityRepository.countUnreadForPairs(client, invitation.workspaceId, [
      { userId: invitation.inviteeUserId, streamId: call.streamId },
    ])
    const pair = counts.get(`${invitation.inviteeUserId}:${call.streamId}`)
    await OutboxRepository.insert(client, "activity:created", {
      workspaceId: invitation.workspaceId,
      targetUserId: invitation.inviteeUserId,
      counts: {
        mentionCount: pair?.mentionCount ?? 0,
        activityCount: pair?.totalCount ?? 0,
      },
      activity: {
        id: activity.id,
        activityType: activity.activityType,
        streamId: activity.streamId,
        messageId: activity.messageId,
        actorId: activity.actorId,
        actorType: activity.actorType,
        context: activity.context,
        createdAt: activity.createdAt.toISOString(),
        isSelf: activity.isSelf,
        emoji: activity.emoji,
      },
    })
  }

  /**
   * Sweep: close endpoints whose lease lapsed, cascade their participants to
   * `left` when no live endpoint remains, and cascade calls to `empty_grace`
   * when no joined participant remains (reason `reaped`). Returns per-stage
   * counts. The CF sessions of reaped endpoints are closed AFTER the DB
   * transition commits (never inside it, INV-41) — media dies with the lease,
   * not with luck — best-effort, per-session errors logged not thrown.
   */
  async reapLapsedEndpoints(
    now: Date = new Date()
  ): Promise<{ endpoints: number; participants: number; calls: number }> {
    const { closedSessionIds, result } = await withTransaction(this.pool, async (client) => {
      const lapsedCallIds = await CallEndpointRepository.findLapsedCallIds(client, now)
      if (lapsedCallIds.length === 0) {
        return { closedSessionIds: [] as string[], result: { endpoints: 0, participants: 0, calls: 0 } }
      }

      // Take the call-row locks first, in id order, so this sweep acquires the
      // call lock before any endpoint/participant lock — the same
      // call→endpoint→participant order every interactive path uses. Reaping
      // endpoints first (as before) AB-BA deadlocked a concurrent leave/remove
      // that locks the call first.
      await CallRepository.lockForUpdateInOrder(client, lapsedCallIds)

      const closed = await CallEndpointRepository.reapLapsed(client, now, lapsedCallIds)
      if (closed.length === 0) {
        return { closedSessionIds: [] as string[], result: { endpoints: 0, participants: 0, calls: 0 } }
      }

      const participantIds = [...new Set(closed.map((e) => e.participantId))]
      const left = await CallParticipantRepository.markLeftWhereNoLiveEndpoint(client, participantIds)

      const callIds = [...new Set(closed.map((e) => e.callId))]
      const graced = await CallRepository.enterGraceIfEmptyBatch(client, {
        callIds,
        graceDeadline: new Date(now.getTime() + EMPTY_GRACE_MS),
      })

      // A graced call is abandoned (its last live endpoint lapsed): retract every
      // outstanding ring in the same tx (INV-7) so the invitee's overlay clears
      // and the caller-gone ring never lands a missed-call activity.
      const cancelledRings = await CallInvitationRepository.cancelRingingForCalls(
        client,
        graced.map((c) => c.id)
      )
      await this.settleCancelledRings(client, cancelledRings)

      // The reap changed membership on every call it touched: bump their roster
      // versions in the same tx (the call rows are already locked FOR UPDATE) so a
      // later roster fan-out is strictly newer than what peers hold (INV-66).
      await CallRepository.bumpRosterVersionBatch(client, callIds)

      // Fan the refreshed roster to each touched call's card in the same tx
      // (INV-7). The call rows are locked; read each streamId to route the event.
      // The sweep spans workspaces, so the workspace id comes from the closed
      // endpoint that named each call.
      const workspaceIdByCall = new Map(closed.map((e) => [e.callId, e.workspaceId]))
      for (const cId of callIds) {
        const wsId = workspaceIdByCall.get(cId)
        if (!wsId) continue
        const touched = await CallRepository.findById(client, wsId, cId)
        if (touched) await this.emitParticipantsChanged(client, wsId, touched.streamId, cId)
      }

      const closedSessionIds = closed.map((e) => e.cfSessionId).filter((id): id is string => !!id)
      return {
        closedSessionIds,
        result: { endpoints: closed.length, participants: left.length, calls: graced.length },
      }
    })

    for (const sessionId of closedSessionIds) {
      await this.bestEffortCloseSession(sessionId)
    }
    return result
  }

  /**
   * Sweep: end `empty_grace` calls past their deadline. The repository re-checks
   * emptiness under each call's row lock, so a call revived between grace entry
   * and this sweep is not ended. Returns the count ended.
   */
  async endGraceExpiredCalls(now: Date = new Date()): Promise<{ ended: number }> {
    return withTransaction(this.pool, async (client) => {
      const ended = await CallRepository.endGraceExpired(client, now)
      // Belt for any ring still ringing on a call that reaches `ended` without
      // having been abandoned through leave/reap: cancel and settle it in the
      // same tx (INV-7) rather than leaving it to lapse into a missed call.
      const cancelledRings = await CallInvitationRepository.cancelRingingForCalls(
        client,
        ended.map((c) => c.id)
      )
      await this.settleCancelledRings(client, cancelledRings)

      // Append the `call_ended` patch (carrying the end summary) for every call
      // that reached `ended` here — the single transition to `ended` for BOTH the
      // completed (last-leave grace) and reaped paths (`ended_reason` on the row
      // distinguishes them). Same tx as the status write (INV-4/7). The card
      // renders its historical state from this payload with zero fetch.
      for (const call of ended) {
        await this.appendCallEnded(client, call)
      }
      return { ended: ended.length }
    })
  }

  /**
   * Append the `call_started` slotted broadcast row (+ its stream outbox) inside
   * the caller's transaction (INV-4/7). The event carries the summary the live
   * card renders; the outbox additionally fans the sidebar dot (workspace-wide
   * for public channels, member user rooms for private/DM).
   */
  private async appendCallStarted(
    client: PoolClient,
    args: { call: Call; streamId: string; streamVisibility: Visibility; startedBy: string }
  ): Promise<void> {
    const payload: CallStartedEventPayload = {
      callId: args.call.id,
      mode: args.call.mode,
      startedBy: args.startedBy,
      startedAt: args.call.startedAt.toISOString(),
    }
    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: args.streamId,
      eventType: "call_started",
      payload,
      actorId: args.startedBy,
      actorType: AuthorTypes.USER,
    })
    const memberUserIds = await this.listStreamMemberUserIds(client, args.streamId)
    await OutboxRepository.insert(client, "stream:call_started", {
      workspaceId: args.call.workspaceId,
      streamId: args.streamId,
      event,
      callId: args.call.id,
      streamVisibility: args.streamVisibility,
      memberUserIds,
    })
  }

  /**
   * Append the `call_ended` patch (+ its stream outbox) inside the caller's
   * transaction. A patch, not a slotted row: it carries the end summary onto the
   * matching `call_started` card. Machine transition, so the event acts as the
   * system (no actorId, like the delegation sweeps).
   */
  private async appendCallEnded(client: PoolClient, call: Call): Promise<void> {
    const stream = await StreamRepository.findById(client, call.streamId)
    if (!stream) return
    const userIdsByCall = await CallParticipantRepository.listUserIdsByCall(client, call.workspaceId, [call.id])
    const endedAt = call.endedAt ?? new Date()
    const payload: CallEndedEventPayload = {
      callId: call.id,
      durationMs: Math.max(0, endedAt.getTime() - call.startedAt.getTime()),
      participantUserIds: userIdsByCall.get(call.id) ?? [],
      endedReason: call.endedReason ?? "completed",
    }
    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: call.streamId,
      eventType: "call_ended",
      payload,
      actorType: AuthorTypes.SYSTEM,
    })
    const memberUserIds = await this.listStreamMemberUserIds(client, call.streamId)
    await OutboxRepository.insert(client, "stream:call_ended", {
      workspaceId: call.workspaceId,
      streamId: call.streamId,
      event,
      callId: call.id,
      streamVisibility: stream.visibility,
      memberUserIds,
    })
  }

  /**
   * Emit `call:participants_changed` (stream-scoped, no timeline row) after a
   * membership transition, inside the caller's transaction. Refreshes the live
   * call card's roster avatars/count for clients in the stream room; the sidebar
   * dot rides the started/ended presence events instead.
   */
  private async emitParticipantsChanged(
    client: PoolClient,
    workspaceId: string,
    streamId: string,
    targetCallId: string
  ): Promise<void> {
    const roster = await CallParticipantRepository.listRoster(client, workspaceId, targetCallId)
    const participantUserIds = roster.map((r) => r.userId)
    await OutboxRepository.insert(client, "call:participants_changed", {
      workspaceId,
      streamId,
      callId: targetCallId,
      participantCount: participantUserIds.length,
      participantUserIds,
    })
  }

  private async listStreamMemberUserIds(client: PoolClient, streamId: string): Promise<string[]> {
    const members = await StreamMemberRepository.list(client, { streamId })
    return members.map((m) => m.memberId)
  }

  private async admitParticipant(
    client: PoolClient,
    params: { call: Call; userId: string; invitedBy: string | null }
  ): Promise<CallParticipant> {
    const participant = await CallParticipantRepository.admit(client, {
      id: callParticipantId(),
      workspaceId: params.call.workspaceId,
      callId: params.call.id,
      userId: params.userId,
      invitedBy: params.invitedBy,
    })
    if (!participant) {
      throw new HttpError("Removed from this call", { status: 403, code: "CALL_PARTICIPANT_REMOVED" })
    }
    return participant
  }

  private async findDmPeer(client: PoolClient, streamId: string, userId: string): Promise<string | null> {
    const members = await StreamMemberRepository.list(client, { streamId })
    const peer = members.find((m) => m.memberId !== userId)
    return peer?.memberId ?? null
  }
}
