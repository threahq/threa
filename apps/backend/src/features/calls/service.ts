import type { Pool, PoolClient } from "pg"
import {
  StreamTypes,
  ActivityTypes,
  AuthorTypes,
  summarizeSdpMSections,
  type CallStartedEventPayload,
  type CallEndedEventPayload,
  type Visibility,
  type ActiveCall,
  type StreamActiveCall,
} from "@threa/types"
import { withTransaction, withClient } from "../../db"
import { HttpError } from "../../lib/errors"
import { logger } from "../../lib/logger"
import {
  callCfSessionCreateTotal,
  callCfSessionCreateDuration,
  callCfErrorsTotal,
  callTimeToJoinSeconds,
  callEndedTotal,
  callRingOutcomesTotal,
} from "../../lib/observability"
import { callId, callInvitationId, callParticipantId, callEndpointId, eventId } from "../../lib/id"
import {
  assertStreamWritable,
  checkStreamAccess,
  StreamMemberRepository,
  StreamRepository,
  StreamEventRepository,
} from "../streams"
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

/** CF proxy operations, the label space for the connect-failure metric. */
type CfOperation = "session_create" | "publish_tracks" | "pull_tracks" | "renegotiate" | "close_tracks"

/** Collision-safe key for a pull authorization set; JSON so no separator can be forged. */
function pullRefKey(sessionId: string, trackName: string): string {
  return JSON.stringify([sessionId, trackName])
}

export interface StartCallResult {
  call: Call
  created: boolean
  participant: CallParticipant
  endpoint: CallEndpoint
  /**
   * The `call_started` event id — the anchor for the call's chat thread (a thread
   * on this event, created lazily on first chat open). Handed to the client so the
   * dock can open the thread panel without loading the host-stream timeline. Null
   * only if the started card row is somehow missing (never for a fresh create).
   */
  chatAnchorId: string | null
  /** See {@link JoinCallResult.supersededEndpointId}. */
  supersededEndpointId: string | null
}

export interface JoinCallResult {
  call: Call
  participant: CallParticipant
  endpoint: CallEndpoint
  /**
   * The endpoint a `takeover` displaced, or null. Its device is still holding a
   * call the server has closed under it, so the caller notifies that endpoint's
   * room after the commit. Never set by a rebind — a rebind keeps the SAME
   * endpoint id, which is the room the arriving device itself sits in.
   */
  supersededEndpointId: string | null
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
    params: {
      workspaceId: string
      streamId: string
      userId: string
      mode: CallMode
      mediaIncarnation?: string
      expectedCallId?: string
      /** Displace this user's other device rather than 409 — see {@link admitEndpoint}. */
      takeover?: boolean
    },
    tx?: PoolClient
  ): Promise<StartCallResult> {
    const { result, closedSessionIds } = await withTransaction(tx ?? this.pool, async (client) => {
      const { target: stream } = await assertStreamWritable(client, {
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        principal: { kind: "user", userId: params.userId },
      })

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

      // Ring-acceptance guard: the client accepted a specific call. If the
      // call it would now join (a re-entered active one or a freshly created one)
      // is not that call, the ring's call ended in the click window — 409 so the
      // overlay clears instead of silently joining/starting a different call. The
      // insert (if any) rolls back with the transaction.
      if (params.expectedCallId && targetCallId !== params.expectedCallId) {
        throw new HttpError("Call has ended", { status: 409, code: "CALL_ENDED" })
      }

      const admitted = await this.joinLockedCall(client, {
        workspaceId: params.workspaceId,
        callId: targetCallId,
        userId: params.userId,
        mediaIncarnation: params.mediaIncarnation,
        takeover: params.takeover,
      })

      // A newly created call is a slotted broadcast row on the host stream
      // (INV-4/7): append it in the SAME transaction as the call insert so every
      // member sees the live card and it survives reload. A join onto an existing
      // call adds no row (the card already exists) — only the roster changes, so
      // resolve the pre-existing card's event id to hand back as the chat anchor.
      let chatAnchorId: string | null
      if (created) {
        chatAnchorId = await this.appendCallStarted(client, {
          call: admitted.call,
          streamId: params.streamId,
          streamVisibility: stream.visibility,
          startedBy: params.userId,
        })
      } else {
        chatAnchorId = await CallRepository.findCallStartedEventId(client, params.streamId, targetCallId)
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

      return {
        result: {
          call: admitted.call,
          created,
          participant: admitted.participant,
          endpoint: admitted.endpoint,
          chatAnchorId,
          supersededEndpointId: admitted.supersededEndpointId,
        },
        closedSessionIds: admitted.closedSessionIds,
      }
    })
    // Close the CF sessions of any endpoint this start superseded (takeover/rebind)
    // AFTER the tx commits, never inside it (INV-41). Only when we own the outermost
    // commit (`tx` unset); a caller-supplied savepoint owns its own teardown point.
    if (!tx) {
      for (const sessionId of closedSessionIds) await this.bestEffortCloseSession(sessionId)
    }
    return result
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
    const { closedSessionIds, ...result } = await withTransaction(tx ?? this.pool, async (client) => {
      const access = await checkCallAccess(client, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        callId: params.callId,
      })
      if (!access) throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
      await assertStreamWritable(client, {
        workspaceId: params.workspaceId,
        streamId: access.call.streamId,
        principal: { kind: "user", userId: params.userId },
      })

      return this.joinLockedCall(client, params)
    })
    // Tear down any endpoint this join superseded (takeover/rebind) after commit (INV-41).
    if (!tx) {
      for (const sessionId of closedSessionIds) await this.bestEffortCloseSession(sessionId)
    }
    return result
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
  ): Promise<JoinCallResult & { closedSessionIds: string[] }> {
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
    const { endpoint, closedCfSessionId, supersededEndpointId } = await this.admitEndpoint(client, {
      params,
      participant,
      live,
      incarnation,
    })

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

    return {
      call,
      participant,
      endpoint,
      supersededEndpointId,
      closedSessionIds: closedCfSessionId ? [closedCfSessionId] : [],
    }
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
  ): Promise<{ endpoint: CallEndpoint; closedCfSessionId: string | null; supersededEndpointId: string | null }> {
    const { params, participant, live, incarnation } = args
    const leaseExpiresAt = new Date(Date.now() + ENDPOINT_LEASE_TTL_MS)
    // The CF session dropped by a takeover/rebind, to close AFTER the tx commits
    // (INV-41). This is the one place the teardown handle was being lost.
    let closedCfSessionId: string | null = null
    // Set ONLY by the takeover branch: that device keeps rendering a call the
    // server just closed under it, so the caller pushes it a control event after
    // the commit. A rebind must never set it — it reuses the endpoint id, so the
    // notification would land on the arriving device instead.
    let supersededEndpointId: string | null = null

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
        if (rebound) {
          // A reload (incarnation change) makes `rebind` clear `cf_session_id`, so
          // capture the OLD session from the pre-rebind row (the call-row lock held
          // by the join serializes this read). A same-incarnation reconnect keeps
          // the session, so nothing is torn down.
          if (live.cfSessionId && live.mediaIncarnation !== incarnation) closedCfSessionId = live.cfSessionId
          return { endpoint: rebound, closedCfSessionId, supersededEndpointId }
        }
        // Lost the row to a concurrent close between read and CAS; fall through to a fresh mint.
      } else if (!params.takeover) {
        throw new HttpError("An active endpoint already exists for this user", {
          status: 409,
          code: "CALL_ENDPOINT_ACTIVE",
        })
      } else {
        const closed = await CallEndpointRepository.close(client, params.workspaceId, live.id)
        closedCfSessionId = closed?.cfSessionId ?? null
        // Only when the close actually landed: a row already closed by a
        // concurrent leave/reap has no device left to notify.
        supersededEndpointId = closed?.id ?? null
      }
    }

    const maxEpoch = await CallEndpointRepository.maxEpochForParticipant(client, params.workspaceId, participant.id)
    const endpoint = await CallEndpointRepository.insert(client, {
      id: callEndpointId(),
      workspaceId: params.workspaceId,
      callId: params.callId,
      participantId: participant.id,
      epoch: maxEpoch + 1,
      mediaIncarnation: incarnation,
      leaseExpiresAt,
    })
    return { endpoint, closedCfSessionId, supersededEndpointId }
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
    const { call, closedSessionIds } = await withTransaction(tx ?? this.pool, async (client) => {
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

      const closed = await CallEndpointRepository.close(client, params.workspaceId, params.endpointId)
      await CallParticipantRepository.markLeftIfNoLiveEndpoint(client, {
        workspaceId: params.workspaceId,
        callId: params.callId,
        userId: params.userId,
      })

      const joined = await CallParticipantRepository.countJoined(client, params.workspaceId, params.callId)
      if (joined === 0 && call.status === "active") {
        // Explicit last-leave ends the call in THIS tx (not empty_grace + a ~45s
        // sweep): the clicker is functionally the last one out, so skip the grace
        // window that only serves disconnect-driven emptiness (the reaper still
        // graces). The CAS returns null on a concurrent join / double last-leave,
        // in which case there is nothing to append.
        const ended = await CallRepository.endActiveIfEmpty(client, {
          workspaceId: params.workspaceId,
          id: params.callId,
          reason: "completed",
        })
        if (ended) await this.appendCallEndedForLeave(client, ended)
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
      return { call: updated, closedSessionIds: closed?.cfSessionId ? [closed.cfSessionId] : [] }
    })
    // Close the reaped endpoint's CF session after the tx commits (INV-41).
    if (!tx) {
      for (const sessionId of closedSessionIds) await this.bestEffortCloseSession(sessionId)
    }
    return { call }
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
    const { call, closedSessionIds } = await withTransaction(tx ?? this.pool, async (client) => {
      const call = await CallRepository.findByIdForUpdate(client, params.workspaceId, params.callId)
      if (!call) {
        throw new HttpError("Call not found", { status: 404, code: "CALL_NOT_FOUND" })
      }
      // An `ended` call is terminal: a self-leave against it is a no-op (idempotent
      // user intent — the rejoin bar's stale "Leave"). Return before touching
      // endpoints or emitting so a `call:participants_changed` never fans out for a
      // dead call and resurrects its card as live on peers still holding the id.
      if (call.status === "ended") {
        return { call, closedSessionIds: [] as string[] }
      }
      const participant = await CallParticipantRepository.findByUser(
        client,
        params.workspaceId,
        params.callId,
        params.userId
      )
      if (!participant) {
        return { call, closedSessionIds: [] as string[] }
      }

      const closed = await CallEndpointRepository.closeByParticipant(client, params.workspaceId, participant.id)
      await CallParticipantRepository.markLeftIfNoLiveEndpoint(client, {
        workspaceId: params.workspaceId,
        callId: params.callId,
        userId: params.userId,
      })

      const joined = await CallParticipantRepository.countJoined(client, params.workspaceId, params.callId)
      if (joined === 0 && call.status === "active") {
        // Explicit last-leave ends the call in THIS tx (see {@link leaveCall}) —
        // grace stays only for the disconnect/reaper path.
        const ended = await CallRepository.endActiveIfEmpty(client, {
          workspaceId: params.workspaceId,
          id: params.callId,
          reason: "completed",
        })
        if (ended) await this.appendCallEndedForLeave(client, ended)
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
      const closedSessionIds = closed.map((e) => e.cfSessionId).filter((id): id is string => !!id)
      return { call: updated, closedSessionIds }
    })
    // Close every reaped endpoint's CF session after the tx commits (INV-41).
    if (!tx) {
      for (const sessionId of closedSessionIds) await this.bestEffortCloseSession(sessionId)
    }
    return { call }
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
    callRingOutcomesTotal.inc({ outcome })
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
      // No callId param: read the endpoint (unlocked) to learn its call, then lock
      // the call row BEFORE the endpoint CAS (call→endpoint lock order). The CAS
      // still fences on epoch + connection_seq, so the unlocked read can't let a
      // stale demotion land on a freshly re-bound endpoint.
      const existing = await CallEndpointRepository.findById(client, params.workspaceId, params.endpointId)
      if (!existing) return null
      await CallRepository.findByIdForUpdate(client, params.workspaceId, existing.callId)
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
      // Lock the call row before any endpoint write: every endpoint-write path
      // takes call→endpoint lock order, matching leave/remove/reap, so contention
      // can't AB-BA deadlock. The subsequent fence read observes the locked row.
      await CallRepository.findByIdForUpdate(client, params.workspaceId, params.callId)
      const { endpoint, call } = await this.loadFencedEndpoint(client, params)
      if (params.mediaState.cameraOn === true && call.mode === "audio_only") {
        throw new HttpError("Camera is not allowed on an audio-only call", {
          status: 409,
          code: "CALL_CAMERA_NOT_ALLOWED",
        })
      }
      const merged: MediaState = { ...endpoint.mediaState, ...params.mediaState }
      const updated = await CallEndpointRepository.setMediaState(client, {
        workspaceId: params.workspaceId,
        id: endpoint.id,
        mediaIncarnation: params.mediaIncarnation,
        mediaState: merged,
      })
      if (!updated) {
        // The endpoint closed or its incarnation was superseded between the fence
        // read and this write — don't bump the roster for state that wasn't persisted.
        throw new HttpError("Endpoint is no longer live", { status: 409, code: "CALL_ENDPOINT_NOT_LIVE" })
      }
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

    const sessionStartedAt = Date.now()
    let created: Awaited<ReturnType<RealtimeMediaApi["createSession"]>>
    try {
      created = await this.cfCall(() => cf.createSession(), "session_create")
    } catch (err) {
      callCfSessionCreateTotal.inc({ status: "error" })
      throw err
    }
    const sessionCreatedAt = Date.now()
    callCfSessionCreateTotal.inc({ status: "success" })
    callCfSessionCreateDuration.observe((sessionCreatedAt - sessionStartedAt) / 1000)
    // Server-side time-to-join: endpoint admission (the mint that created the row)
    // → CF session created — measured AFTER the createSession round-trip, so the
    // media-connect latency is included. First binding only: a reload REBINDS the
    // same row (created_at preserved, cf_session_id cleared, connection_seq bumped),
    // so observing a rebind would charge the whole prior connected duration to the
    // histogram. connection_seq is 0 only at mint; any rebind makes it ≥1.
    if (endpoint.connectionSeq === 0) {
      callTimeToJoinSeconds.observe(Math.max(0, sessionCreatedAt - endpoint.createdAt.getTime()) / 1000)
    }

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
   * Publish local tracks: CF `addLocalTracks` (outside any tx), then merge the
   * declared tracks into the endpoint's registry by kind, bump the roster
   * version, and return the CF answer plus the fresh snapshot. Peers pull these
   * tracks on the roster change (CF pushes no notification). Merge, never
   * overwrite: the client declares one track per publish (mic, then camera), so
   * writing the declared set verbatim dropped the mic entry on every camera
   * publish — peers pull from this registry, so video calls went silent.
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
    const { endpoint, call } = await this.fenceEndpoint(params)
    // Cap camera on the track path too, not only the media-state claim gate — the
    // published-track registry is the other route a camera reaches peers. Screen
    // share stays allowed (huddle semantics), matching setEndpointMediaState.
    if (call.mode === "audio_only" && params.tracks.some((t) => t.kind === "camera")) {
      throw new HttpError("Camera is not allowed on an audio-only call", {
        status: 409,
        code: "CALL_CAMERA_NOT_ALLOWED",
      })
    }
    const cfSessionId = this.requireCfSession(endpoint)

    const localTracks: LocalTrackRequest[] = params.tracks.map((t) => ({
      location: "local",
      trackName: t.trackName,
      mid: t.mid,
    }))
    const cfResult = await this.cfCall(
      () => cf.addLocalTracks(cfSessionId, { sdp: params.sdp, tracks: localTracks }),
      "publish_tracks"
    )

    // CF reports failures per track in a 2xx body (INV — the HTTP status alone is
    // not success). A failed track must NOT be written into the registry as if it
    // were pullable, so surface it as a provider error and skip the registry write.
    const failedTracks = cfResult.tracks.filter((t) => t.errorCode)
    if (failedTracks.length > 0) {
      callCfErrorsTotal.inc({ operation: "publish_tracks", cf_code: failedTracks[0].errorCode ?? "unknown" })
      throw new HttpError("Calls media provider error", {
        status: 502,
        code: "CALL_MEDIA_PROVIDER_ERROR",
        details: {
          tracks: failedTracks.map((t) => ({
            trackName: t.trackName,
            errorCode: t.errorCode,
            errorDescription: t.errorDescription,
          })),
        },
      })
    }

    logger.info(
      {
        callId: params.callId,
        endpointId: params.endpointId,
        kinds: params.tracks.map((t) => t.kind),
        offer: summarizeSdpMSections(params.sdp.sdp),
        answer: summarizeSdpMSections(cfResult.sessionDescription?.sdp),
      },
      "CF publish negotiated"
    )

    const declared: PublishedTrack[] = params.tracks.map((t) => ({ kind: t.kind, trackName: t.trackName }))
    const declaredKinds = new Set(declared.map((t) => t.kind))
    const snapshot = await this.mutateRegistry(params, (current) => [
      ...current.filter((t) => !declaredKinds.has(t.kind)),
      ...declared,
    ])
    return { cf: cfResult, snapshot }
  }

  /**
   * Rewrite an endpoint's published-track registry under the call lock. The
   * base registry is re-read INSIDE the transaction: publish and unpublish each
   * declare only their own kinds, and computing the write from a read taken
   * before the CF round-trip loses whichever concurrent declaration commits
   * first. Entries from another incarnation never carry over — a rebind resets
   * the registry at cf/session create, and the fenced write rejects stale
   * writers.
   */
  private async mutateRegistry(
    params: { workspaceId: string; callId: string; endpointId: string; mediaIncarnation: string },
    mutate: (current: PublishedTrack[]) => PublishedTrack[]
  ): Promise<CallRosterSnapshot> {
    return withTransaction(this.pool, async (client) => {
      // Lock the call row before the endpoint write (call→endpoint lock order).
      await CallRepository.findByIdForUpdate(client, params.workspaceId, params.callId)
      const current = await CallEndpointRepository.findById(client, params.workspaceId, params.endpointId)
      const base = current?.mediaIncarnation === params.mediaIncarnation ? current.publishedTracks : []
      const updated = await CallEndpointRepository.setPublishedTracks(client, {
        workspaceId: params.workspaceId,
        id: params.endpointId,
        mediaIncarnation: params.mediaIncarnation,
        publishedTracks: mutate(base),
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
    await this.assertPullableRefs(params.workspaceId, params.callId, endpoint, params.tracks)
    const cfResult = await this.cfCall(() => cf.pullRemoteTracks(cfSessionId, { tracks: params.tracks }), "pull_tracks")
    logger.info(
      {
        callId: params.callId,
        endpointId: params.endpointId,
        trackNames: params.tracks.map((t) => t.trackName),
        offer: summarizeSdpMSections(cfResult.sessionDescription?.sdp),
      },
      "CF pull negotiated"
    )
    return { cf: cfResult }
  }

  /**
   * Authorize every pull ref against THIS call's live roster. CF sessions are
   * app-scoped, so an unvalidated `{sessionId, trackName}` lets a hostile
   * participant of call A pull media from any other call by replaying a
   * `cfSessionId` a roster elsewhere exposed. A ref is honored only when its
   * `(cfSessionId, trackName)` belongs to a live endpoint of this call other than
   * the caller's own. Any ref outside that set is rejected 403 — the message names
   * nothing about other calls (no existence leak).
   */
  private async assertPullableRefs(
    workspaceId: string,
    targetCallId: string,
    self: CallEndpoint,
    tracks: RemoteTrackRequest[]
  ): Promise<void> {
    const live = await CallEndpointRepository.listLiveByCall(this.pool, workspaceId, targetCallId)
    const allowed = new Set<string>()
    for (const ep of live) {
      if (ep.id === self.id || !ep.cfSessionId) continue
      for (const track of ep.publishedTracks) allowed.add(pullRefKey(ep.cfSessionId, track.trackName))
    }
    for (const ref of tracks) {
      if (!allowed.has(pullRefKey(ref.sessionId, ref.trackName))) {
        throw new HttpError("Track is not pullable on this call", { status: 403, code: "CALL_PULL_FORBIDDEN" })
      }
    }
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
    const cfResult = await this.cfCall(() => cf.renegotiateSession(cfSessionId, params.sdp), "renegotiate")
    return { cf: cfResult }
  }

  /**
   * Close published tracks: CF `tracks/close` (outside any tx). When the caller
   * names the kinds it is unpublishing, prune them from the registry, bump the
   * roster, and return the fresh snapshot so peers stop pulling dead tracks.
   *
   * The registry prune comes FIRST and survives a CF failure: the registry is
   * what peers pull from, and an entry for a track whose media is gone makes
   * every peer's pull hang at CF until timeout. CF-side close is best-effort by
   * nature (CF reaps inactive tracks; teardown already treats it that way), so a
   * provider error on an unpublish is logged + counted, never allowed to keep
   * the phantom alive. Mid-less calls (cleanup after a client-side publish
   * failure — no acknowledged m-line to close) skip CF entirely.
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
  }): Promise<{ cf: CloseTracksResult | null; snapshot?: CallRosterSnapshot }> {
    const cf = this.requireCloudflare()
    const { endpoint } = await this.fenceEndpoint(params)
    const cfSessionId = this.requireCfSession(endpoint)

    let snapshot: CallRosterSnapshot | undefined
    if (params.unpublishKinds && params.unpublishKinds.length > 0) {
      const remove = new Set(params.unpublishKinds)
      snapshot = await this.mutateRegistry(params, (current) => current.filter((t) => !remove.has(t.kind)))
    }

    if (params.mids.length === 0) return { cf: null, snapshot }
    let cfResult: CloseTracksResult | null = null
    try {
      cfResult = await this.cfCall(
        () => cf.closeTracks(cfSessionId, { mids: params.mids, force: false, sdp: params.sdp }),
        "close_tracks"
      )
    } catch (err) {
      const unpublishing = (params.unpublishKinds?.length ?? 0) > 0
      if (!unpublishing || !(err instanceof HttpError) || err.code !== "CALL_MEDIA_PROVIDER_ERROR") throw err
      logger.warn(
        { err, callId: params.callId, endpointId: params.endpointId, mids: params.mids },
        "CF close failed on unpublish; registry already pruned"
      )
    }
    return { cf: cfResult, snapshot }
  }

  /**
   * Run a CF call, translating a transport/CF error into a surfaced HttpError
   * (502/504). `operation` labels the connect-failure metric so renegotiation
   * failures and session-create failures are separable in one counter.
   */
  private async cfCall<T>(fn: () => Promise<T>, operation: CfOperation): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof CloudflareRealtimeError) {
        callCfErrorsTotal.inc({ operation, cf_code: err.code })
        const status = err.code === "CF_TIMEOUT" ? 504 : 502
        throw new HttpError("Calls media provider error", {
          status,
          code: "CALL_MEDIA_PROVIDER_ERROR",
          details: { cfCode: err.code, cfErrorCode: err.cfErrorCode, cfErrorDescription: err.cfErrorDescription },
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
    const { removed, closedSessionIds } = await withTransaction(tx ?? this.pool, async (client) => {
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

      const closedEndpoints = await CallEndpointRepository.closeByParticipant(client, params.workspaceId, removed.id)

      const joined = await CallParticipantRepository.countJoined(client, params.workspaceId, params.callId)
      if (joined === 0 && call.status === "active") {
        await CallRepository.enterGraceIfEmpty(client, {
          workspaceId: params.workspaceId,
          id: params.callId,
          graceDeadline: new Date(Date.now() + EMPTY_GRACE_MS),
          reason: "completed",
        })
        // The call is now empty: retract every outstanding ring in the same tx
        // (INV-7) so an emptied call's rings never lapse into false missed calls.
        const cancelled = await CallInvitationRepository.cancelRingingForCall(client, {
          workspaceId: params.workspaceId,
          callId: params.callId,
        })
        await this.settleCancelledRings(client, cancelled)
      } else {
        // The call lives on, but the removed user's own outgoing ring is abandoned
        // (they can no longer answer for the invitee they were calling).
        const cancelled = await CallInvitationRepository.cancelRingingByInviter(client, {
          workspaceId: params.workspaceId,
          callId: params.callId,
          inviterUserId: params.targetUserId,
        })
        await this.settleCancelledRings(client, cancelled)
      }

      // Removal is a membership change: bump the roster version in the same tx as
      // the participant-removed/endpoint-close writes (INV-66).
      await CallRepository.bumpRosterVersion(client, params.workspaceId, params.callId)
      await this.emitParticipantsChanged(client, params.workspaceId, call.streamId, params.callId)

      const closedSessionIds = closedEndpoints.map((e) => e.cfSessionId).filter((id): id is string => !!id)
      return { removed, closedSessionIds }
    })
    // Tear down the removed participant's CF sessions after the tx commits (INV-41).
    if (!tx) {
      for (const sessionId of closedSessionIds) await this.bestEffortCloseSession(sessionId)
    }
    return removed
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
   * would. The call row supplies the host stream and mode; a missing inviter/stream
   * degrades the context fields, but a missing call row skips the activity entirely
   * — there is no stream to land the miss on.
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
      await this.appendCallsEnded(client, ended)
      return { ended: ended.length }
    })
  }

  /**
   * Batch the reads the per-call `call_ended` appends share, once for the whole
   * grace-end sweep (INV-56). The sweep spans workspaces, so the ever-participant
   * read groups by workspace (INV-8); the stream row and member reads are
   * id-keyed across the set. The event/outbox append stays a loop — neither has a
   * batch insert — but every lookup it needs is already resolved.
   */
  private async appendCallsEnded(client: PoolClient, calls: Call[]): Promise<void> {
    if (calls.length === 0) return

    const callIdsByWorkspace = new Map<string, string[]>()
    for (const call of calls) {
      const ids = callIdsByWorkspace.get(call.workspaceId)
      if (ids) ids.push(call.id)
      else callIdsByWorkspace.set(call.workspaceId, [call.id])
    }
    const participantUserIdsByCall = new Map<string, string[]>()
    for (const [workspaceId, callIds] of callIdsByWorkspace) {
      const partial = await CallParticipantRepository.listUserIdsByCall(client, workspaceId, callIds)
      for (const [callId, userIds] of partial) participantUserIdsByCall.set(callId, userIds)
    }

    const streamIds = [...new Set(calls.map((c) => c.streamId))]
    const streamById = new Map((await StreamRepository.findByIds(client, streamIds)).map((s) => [s.id, s]))

    const memberUserIdsByStream = new Map<string, string[]>()
    for (const member of await StreamMemberRepository.list(client, { streamIds })) {
      const ids = memberUserIdsByStream.get(member.streamId)
      if (ids) ids.push(member.memberId)
      else memberUserIdsByStream.set(member.streamId, [member.memberId])
    }

    for (const call of calls) {
      const stream = streamById.get(call.streamId)
      if (!stream) continue
      await this.appendCallEnded(client, call, {
        streamVisibility: stream.visibility,
        participantUserIds: participantUserIdsByCall.get(call.id) ?? [],
        memberUserIds: memberUserIdsByStream.get(call.streamId) ?? [],
      })
    }
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
  ): Promise<string> {
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
    return event.id
  }

  /**
   * Assemble the `call_ended` ctx for an explicit last-leave and append it in the
   * caller's transaction (INV-4/7). Mirrors {@link appendCallsEnded}'s per-call
   * reads — ever-participant set, host-stream visibility, member UserIds — for a
   * single just-ended call. A missing stream row (a call always has a host stream)
   * skips the append: there is nowhere to land the card.
   */
  private async appendCallEndedForLeave(client: PoolClient, call: Call): Promise<void> {
    const stream = await StreamRepository.findById(client, call.streamId)
    if (!stream) return
    const participantUserIdsByCall = await CallParticipantRepository.listUserIdsByCall(client, call.workspaceId, [
      call.id,
    ])
    const memberUserIds = await this.listStreamMemberUserIds(client, call.streamId)
    await this.appendCallEnded(client, call, {
      streamVisibility: stream.visibility,
      participantUserIds: participantUserIdsByCall.get(call.id) ?? [],
      memberUserIds,
    })
  }

  /**
   * Append the `call_ended` patch (+ its stream outbox) inside the caller's
   * transaction. A patch, not a slotted row: it carries the end summary onto the
   * matching `call_started` card. Machine transition, so the event acts as the
   * system (no actorId, like the delegation sweeps).
   */
  private async appendCallEnded(
    client: PoolClient,
    call: Call,
    ctx: { streamVisibility: Visibility; participantUserIds: string[]; memberUserIds: string[] }
  ): Promise<void> {
    const endedAt = call.endedAt ?? new Date()
    const payload: CallEndedEventPayload = {
      callId: call.id,
      durationMs: Math.max(0, endedAt.getTime() - call.startedAt.getTime()),
      participantUserIds: ctx.participantUserIds,
      endedReason: call.endedReason ?? "completed",
    }
    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: call.streamId,
      eventType: "call_ended",
      payload,
      actorType: AuthorTypes.SYSTEM,
    })
    await OutboxRepository.insert(client, "stream:call_ended", {
      workspaceId: call.workspaceId,
      streamId: call.streamId,
      event,
      callId: call.id,
      streamVisibility: ctx.streamVisibility,
      memberUserIds: ctx.memberUserIds,
    })
    callEndedTotal.inc({ reason: payload.endedReason })
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
