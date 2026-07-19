import type { Pool, PoolClient } from "pg"
import { StreamTypes } from "@threa/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { callId, callInvitationId, callParticipantId, callEndpointId } from "../../lib/id"
import { checkStreamAccess, StreamMemberRepository } from "../streams"
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
} from "./repository"
import { EMPTY_GRACE_MS, ENDPOINT_LEASE_TTL_MS, INVITATION_TTL_MS, CALL_PRODUCT_CAP, type CallMode } from "./config"

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

/**
 * Lifecycle owner for calls (M0 PR 0.1) — transport-independent state machines
 * only: no sockets, no Cloudflare, no outbox emission yet. A call is a set of
 * rows in call-scoped tracking tables (INV-57) attached to an existing stream.
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

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool
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
    params: { workspaceId: string; streamId: string; userId: string; mode: CallMode },
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
      })

      if (created && stream.type === StreamTypes.DM) {
        const peerId = await this.findDmPeer(client, params.streamId, params.userId)
        if (peerId) {
          await CallInvitationRepository.insertRinging(client, {
            id: callInvitationId(),
            workspaceId: params.workspaceId,
            callId: targetCallId,
            inviteeUserId: peerId,
            inviterUserId: params.userId,
            expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
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
    params: { workspaceId: string; callId: string; userId: string; takeover?: boolean },
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
    params: { workspaceId: string; callId: string; userId: string; takeover?: boolean }
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

    const live = await CallEndpointRepository.findLiveByParticipant(client, params.workspaceId, participant.id)
    if (live) {
      if (!params.takeover) {
        throw new HttpError("An active endpoint already exists for this user", {
          status: 409,
          code: "CALL_ENDPOINT_ACTIVE",
        })
      }
      await CallEndpointRepository.close(client, params.workspaceId, live.id)
    }

    const maxEpoch = await CallEndpointRepository.maxEpochForParticipant(client, params.workspaceId, participant.id)
    const endpoint = await CallEndpointRepository.insert(client, {
      id: callEndpointId(),
      workspaceId: params.workspaceId,
      callId: params.callId,
      participantId: participant.id,
      epoch: maxEpoch + 1,
      leaseExpiresAt: new Date(Date.now() + ENDPOINT_LEASE_TTL_MS),
    })

    await CallInvitationRepository.acceptRingingForUser(client, {
      workspaceId: params.workspaceId,
      callId: params.callId,
      inviteeUserId: params.userId,
    })

    return { call, participant, endpoint }
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
      }

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
      return cancelled
    })
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

      return removed
    })
  }

  /** Sweep: expire `ringing` invitations past their deadline. Returns the count. */
  async expireStaleRings(now: Date = new Date()): Promise<{ expired: number }> {
    return withTransaction(this.pool, async (client) => {
      const expired = await CallInvitationRepository.expireStaleRings(client, now)
      return { expired: expired.length }
    })
  }

  /**
   * Sweep: close endpoints whose lease lapsed, cascade their participants to
   * `left` when no live endpoint remains, and cascade calls to `empty_grace`
   * when no joined participant remains (reason `reaped`). Returns per-stage
   * counts.
   */
  async reapLapsedEndpoints(
    now: Date = new Date()
  ): Promise<{ endpoints: number; participants: number; calls: number }> {
    return withTransaction(this.pool, async (client) => {
      const lapsedCallIds = await CallEndpointRepository.findLapsedCallIds(client, now)
      if (lapsedCallIds.length === 0) return { endpoints: 0, participants: 0, calls: 0 }

      // Take the call-row locks first, in id order, so this sweep acquires the
      // call lock before any endpoint/participant lock — the same
      // call→endpoint→participant order every interactive path uses. Reaping
      // endpoints first (as before) AB-BA deadlocked a concurrent leave/remove
      // that locks the call first.
      await CallRepository.lockForUpdateInOrder(client, lapsedCallIds)

      const closed = await CallEndpointRepository.reapLapsed(client, now, lapsedCallIds)
      if (closed.length === 0) return { endpoints: 0, participants: 0, calls: 0 }

      const participantIds = [...new Set(closed.map((e) => e.participantId))]
      const left = await CallParticipantRepository.markLeftWhereNoLiveEndpoint(client, participantIds)

      const callIds = [...new Set(closed.map((e) => e.callId))]
      const graced = await CallRepository.enterGraceIfEmptyBatch(client, {
        callIds,
        graceDeadline: new Date(now.getTime() + EMPTY_GRACE_MS),
      })

      return { endpoints: closed.length, participants: left.length, calls: graced.length }
    })
  }

  /**
   * Sweep: end `empty_grace` calls past their deadline. The repository re-checks
   * emptiness under each call's row lock, so a call revived between grace entry
   * and this sweep is not ended. Returns the count ended.
   */
  async endGraceExpiredCalls(now: Date = new Date()): Promise<{ ended: number }> {
    return withTransaction(this.pool, async (client) => {
      const ended = await CallRepository.endGraceExpired(client, now)
      return { ended: ended.length }
    })
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
