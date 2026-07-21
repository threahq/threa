import type { Querier } from "../../db"
import { sql } from "../../db"
import {
  type CallStatus,
  type CallMode,
  type CallMediaTransport,
  type CallEndedReason,
  type CallInvitationStatus,
  type CallParticipantStatus,
  type CallEndpointStatus,
  type MediaState,
  type PublishedTrack,
} from "./config"

// ── calls ────────────────────────────────────────────────────────────────────

interface CallRow {
  id: string
  workspace_id: string
  stream_id: string
  started_by: string
  status: string
  mode: string
  media_transport: string
  chat_stream_id: string | null
  sharing_endpoint_id: string | null
  roster_version: number
  grace_deadline: Date | null
  ended_reason: string | null
  started_at: Date
  ended_at: Date | null
  status_changed_at: Date
  created_at: Date
  updated_at: Date
}

export interface Call {
  id: string
  workspaceId: string
  streamId: string
  startedBy: string
  status: CallStatus
  mode: CallMode
  mediaTransport: CallMediaTransport
  chatStreamId: string | null
  sharingEndpointId: string | null
  rosterVersion: number
  graceDeadline: Date | null
  endedReason: CallEndedReason | null
  startedAt: Date
  endedAt: Date | null
  statusChangedAt: Date
  createdAt: Date
  updatedAt: Date
}

const CALL_COLUMNS = `
  id, workspace_id, stream_id, started_by, status, mode, media_transport,
  chat_stream_id, sharing_endpoint_id, roster_version, grace_deadline, ended_reason,
  started_at, ended_at, status_changed_at, created_at, updated_at
`

function mapCall(row: CallRow): Call {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    startedBy: row.started_by,
    status: row.status as CallStatus,
    mode: row.mode as CallMode,
    mediaTransport: row.media_transport as CallMediaTransport,
    chatStreamId: row.chat_stream_id,
    sharingEndpointId: row.sharing_endpoint_id,
    rosterVersion: row.roster_version,
    graceDeadline: row.grace_deadline,
    endedReason: row.ended_reason as CallEndedReason | null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const CallRepository = {
  /**
   * Product-glare resolution (INV-20): insert a new active call, but do nothing
   * if the one-active-call-per-stream partial index already holds a row. Returns
   * the inserted call, or `null` when another caller already owns the slot — the
   * service then re-reads the winner in the same transaction.
   */
  async insertIfNoActiveCall(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      streamId: string
      startedBy: string
      mode: CallMode
      mediaTransport: CallMediaTransport
    }
  ): Promise<Call | null> {
    const result = await db.query<CallRow>(sql`
      INSERT INTO calls (id, workspace_id, stream_id, started_by, status, mode, media_transport)
      VALUES (${params.id}, ${params.workspaceId}, ${params.streamId}, ${params.startedBy},
              'active', ${params.mode}, ${params.mediaTransport})
      ON CONFLICT (workspace_id, stream_id) WHERE status IN ('active', 'empty_grace')
      DO NOTHING
      RETURNING ${sql.raw(CALL_COLUMNS)}
    `)
    return result.rows[0] ? mapCall(result.rows[0]) : null
  },

  /** The one joinable (active|empty_grace) call for a stream, if any. */
  async findOpenByStream(db: Querier, workspaceId: string, streamId: string): Promise<Call | null> {
    const result = await db.query<CallRow>(sql`
      SELECT ${sql.raw(CALL_COLUMNS)} FROM calls
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
        AND status IN ('active', 'empty_grace')
    `)
    return result.rows[0] ? mapCall(result.rows[0]) : null
  },

  /**
   * The live calls (`active`/`empty_grace`) on any of `streamIds`, each with its
   * current joined-participant count — the workspace bootstrap's `activeCalls`
   * sidebar-dot seed. Caller passes only stream ids the viewer can access (INV-62
   * is enforced upstream, at the accessible-stream projection). Batched (INV-56).
   */
  async listActiveByStreamIds(
    db: Querier,
    workspaceId: string,
    streamIds: readonly string[]
  ): Promise<Array<{ callId: string; streamId: string; mode: CallMode; participantCount: number }>> {
    if (streamIds.length === 0) return []
    const result = await db.query<{ id: string; stream_id: string; mode: string; participant_count: string }>(sql`
      SELECT c.id, c.stream_id, c.mode,
        (SELECT COUNT(*) FROM call_participants p
           WHERE p.workspace_id = c.workspace_id AND p.call_id = c.id AND p.status = 'joined') AS participant_count
      FROM calls c
      WHERE c.workspace_id = ${workspaceId}
        AND c.stream_id = ANY(${streamIds as string[]})
        AND c.status IN ('active', 'empty_grace')
    `)
    return result.rows.map((row) => ({
      callId: row.id,
      streamId: row.stream_id,
      mode: row.mode as CallMode,
      participantCount: Number(row.participant_count),
    }))
  },

  /** Read a call, workspace-scoped (INV-8). */
  async findById(db: Querier, workspaceId: string, id: string): Promise<Call | null> {
    const result = await db.query<CallRow>(sql`
      SELECT ${sql.raw(CALL_COLUMNS)} FROM calls
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return result.rows[0] ? mapCall(result.rows[0]) : null
  },

  /** Lock a call row for the join/leave lifecycle (serializes revive-vs-reap). */
  async findByIdForUpdate(db: Querier, workspaceId: string, id: string): Promise<Call | null> {
    const result = await db.query<CallRow>(sql`
      SELECT ${sql.raw(CALL_COLUMNS)} FROM calls
      WHERE workspace_id = ${workspaceId} AND id = ${id}
      FOR UPDATE
    `)
    return result.rows[0] ? mapCall(result.rows[0]) : null
  },

  /**
   * Lock a batch of call rows in ascending id order (INV-56). The reaper takes
   * these BEFORE touching any endpoint or participant, matching the
   * call→endpoint→participant lock order every interactive path already uses via
   * {@link findByIdForUpdate}; without it the endpoint-first reap would AB-BA
   * deadlock a concurrent leave/remove that locks call-first. `ORDER BY id` under
   * a single `FOR UPDATE` fixes acquisition order so lockers never cross. Locked
   * by global id (no workspace filter) as the sweeper runs workspace-agnostic.
   */
  async lockForUpdateInOrder(db: Querier, callIds: readonly string[]): Promise<void> {
    if (callIds.length === 0) return
    await db.query(sql`
      SELECT id FROM calls
      WHERE id = ANY(${callIds as string[]})
      ORDER BY id
      FOR UPDATE
    `)
  },

  /**
   * CAS `empty_grace → active` on a join-during-grace, clearing the deadline and
   * the provisional end reason so a revived call can never carry a stale one.
   */
  async reviveFromGrace(db: Querier, workspaceId: string, id: string): Promise<Call | null> {
    const result = await db.query<CallRow>(sql`
      UPDATE calls SET
        status = 'active', grace_deadline = NULL, ended_reason = NULL,
        status_changed_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'empty_grace'
      RETURNING ${sql.raw(CALL_COLUMNS)}
    `)
    return result.rows[0] ? mapCall(result.rows[0]) : null
  },

  /**
   * CAS `active → empty_grace`, recording the provisional end reason at the
   * moment grace is entered (`completed` on a normal last-leave, `reaped` on a
   * sweeper cascade). The reason is carried through to the eventual `ended` row,
   * so `ended_reason` reads the same value whether grace ends normally or by
   * timeout; a revive clears it. Guarded on the absence of any joined
   * participant so a concurrent join wins the row.
   */
  async enterGraceIfEmpty(
    db: Querier,
    params: { workspaceId: string; id: string; graceDeadline: Date; reason: CallEndedReason }
  ): Promise<Call | null> {
    const result = await db.query<CallRow>(sql`
      UPDATE calls c SET
        status = 'empty_grace', grace_deadline = ${params.graceDeadline},
        ended_reason = ${params.reason}, status_changed_at = NOW(), updated_at = NOW()
      WHERE c.workspace_id = ${params.workspaceId} AND c.id = ${params.id} AND c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM call_participants p
          WHERE p.workspace_id = c.workspace_id AND p.call_id = c.id AND p.status = 'joined'
        )
      RETURNING ${sql.raw(CALL_COLUMNS)}
    `)
    return result.rows[0] ? mapCall(result.rows[0]) : null
  },

  /**
   * CAS `active → ended` on an explicit last-leave: end the call in the same tx
   * as the leave instead of parking it in `empty_grace` for the 15s sweeper. The
   * guard mirrors {@link enterGraceIfEmpty} — `status = 'active'` AND no joined
   * participant (INV-20), a roster predicate not a bare flag — so a concurrent
   * join wins the row and a double last-leave ends it exactly once (the loser
   * gets `null`, not an error). Records `ended_reason` + `ended_at` so the
   * caller's `appendCallEnded` reads the same summary the grace-end sweep
   * produces. Grace is retained for disconnect-driven emptiness (the reaper);
   * this is only the explicit-leave path.
   */
  async endActiveIfEmpty(
    db: Querier,
    params: { workspaceId: string; id: string; reason: CallEndedReason }
  ): Promise<Call | null> {
    const result = await db.query<CallRow>(sql`
      UPDATE calls c SET
        status = 'ended', ended_reason = ${params.reason}, ended_at = NOW(),
        status_changed_at = NOW(), updated_at = NOW()
      WHERE c.workspace_id = ${params.workspaceId} AND c.id = ${params.id} AND c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM call_participants p
          WHERE p.workspace_id = c.workspace_id AND p.call_id = c.id AND p.status = 'joined'
        )
      RETURNING ${sql.raw(CALL_COLUMNS)}
    `)
    return result.rows[0] ? mapCall(result.rows[0]) : null
  },

  /**
   * Batch cascade for the endpoint reaper (INV-56): flip the named calls to
   * `empty_grace` (reason `reaped`) when their last joined participant just went
   * away. The `NOT EXISTS` re-verifies emptiness against the current
   * participant set, so a call that still has a live joined member is skipped.
   */
  async enterGraceIfEmptyBatch(
    db: Querier,
    params: { callIds: readonly string[]; graceDeadline: Date }
  ): Promise<Call[]> {
    if (params.callIds.length === 0) return []
    const result = await db.query<CallRow>(sql`
      UPDATE calls c SET
        status = 'empty_grace', grace_deadline = ${params.graceDeadline},
        ended_reason = 'reaped', status_changed_at = NOW(), updated_at = NOW()
      WHERE c.id = ANY(${params.callIds as string[]}) AND c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM call_participants p
          WHERE p.workspace_id = c.workspace_id AND p.call_id = c.id AND p.status = 'joined'
        )
      RETURNING ${sql.raw(CALL_COLUMNS)}
    `)
    return result.rows.map(mapCall)
  },

  /**
   * Set-based grace-expiry (INV-56): end every `empty_grace` call past its
   * deadline in one statement. The UPDATE takes each call's row lock, which
   * serializes against `joinCall`'s `FOR UPDATE`, and the `NOT EXISTS` re-checks
   * emptiness — so a call revived (or rejoined) between grace entry and the
   * sweep is not ended (no join-vs-reap write skew). `ended_reason` is left as
   * set on grace entry.
   */
  async endGraceExpired(db: Querier, now: Date): Promise<Call[]> {
    const result = await db.query<CallRow>(sql`
      UPDATE calls c SET
        status = 'ended', ended_at = ${now}, status_changed_at = NOW(), updated_at = NOW()
      WHERE c.status = 'empty_grace' AND c.grace_deadline <= ${now}
        AND NOT EXISTS (
          SELECT 1 FROM call_participants p
          WHERE p.workspace_id = c.workspace_id AND p.call_id = c.id AND p.status = 'joined'
        )
      RETURNING ${sql.raw(CALL_COLUMNS)}
    `)
    return result.rows.map(mapCall)
  },

  /**
   * Monotonically bump the roster version (INV-66). Every membership/media-state
   * change bumps it so clients drop a stale snapshot by version. Single atomic
   * increment — no read-modify-write. Returns the new version (`null` if the
   * call vanished).
   */
  async bumpRosterVersion(db: Querier, workspaceId: string, id: string): Promise<number | null> {
    const result = await db.query<{ roster_version: number }>(sql`
      UPDATE calls SET roster_version = roster_version + 1, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${id}
      RETURNING roster_version
    `)
    return result.rows[0]?.roster_version ?? null
  },

  /**
   * Batch roster-version bump for the reaper cascade (INV-56, INV-66): one atomic
   * increment across every call whose membership the sweep just changed. Locked by
   * global id (the sweeper already holds these call rows FOR UPDATE and runs
   * workspace-agnostic), matching {@link lockForUpdateInOrder}.
   */
  async bumpRosterVersionBatch(db: Querier, callIds: readonly string[]): Promise<void> {
    if (callIds.length === 0) return
    await db.query(sql`
      UPDATE calls SET roster_version = roster_version + 1, updated_at = NOW()
      WHERE id = ANY(${callIds as string[]})
    `)
  },
}

// ── call_invitations ──────────────────────────────────────────────────────────

interface CallInvitationRow {
  id: string
  workspace_id: string
  call_id: string
  invitee_user_id: string
  inviter_user_id: string
  status: string
  expires_at: Date
  created_at: Date
  status_changed_at: Date
}

export interface CallInvitation {
  id: string
  workspaceId: string
  callId: string
  inviteeUserId: string
  inviterUserId: string
  status: CallInvitationStatus
  expiresAt: Date
  createdAt: Date
  statusChangedAt: Date
}

const INVITATION_COLUMNS = `
  id, workspace_id, call_id, invitee_user_id, inviter_user_id,
  status, expires_at, created_at, status_changed_at
`

function mapInvitation(row: CallInvitationRow): CallInvitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    inviteeUserId: row.invitee_user_id,
    inviterUserId: row.inviter_user_id,
    status: row.status as CallInvitationStatus,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    statusChangedAt: row.status_changed_at,
  }
}

export const CallInvitationRepository = {
  async insertRinging(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      callId: string
      inviteeUserId: string
      inviterUserId: string
      expiresAt: Date
    }
  ): Promise<CallInvitation> {
    const result = await db.query<CallInvitationRow>(sql`
      INSERT INTO call_invitations (
        id, workspace_id, call_id, invitee_user_id, inviter_user_id, status, expires_at
      ) VALUES (
        ${params.id}, ${params.workspaceId}, ${params.callId}, ${params.inviteeUserId},
        ${params.inviterUserId}, 'ringing', ${params.expiresAt}
      )
      RETURNING ${sql.raw(INVITATION_COLUMNS)}
    `)
    return mapInvitation(result.rows[0])
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<CallInvitation | null> {
    const result = await db.query<CallInvitationRow>(sql`
      SELECT ${sql.raw(INVITATION_COLUMNS)} FROM call_invitations
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return result.rows[0] ? mapInvitation(result.rows[0]) : null
  },

  /**
   * CAS every `ringing` invitation for this user on this call to `accepted`
   * (join is a change of mind even after a decline, so only live rings are
   * accepted). Returns the accepted rows.
   */
  async acceptRingingForUser(
    db: Querier,
    params: { workspaceId: string; callId: string; inviteeUserId: string }
  ): Promise<CallInvitation[]> {
    const result = await db.query<CallInvitationRow>(sql`
      UPDATE call_invitations SET status = 'accepted', status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND call_id = ${params.callId}
        AND invitee_user_id = ${params.inviteeUserId} AND status = 'ringing'
      RETURNING ${sql.raw(INVITATION_COLUMNS)}
    `)
    return result.rows.map(mapInvitation)
  },

  /** CAS `ringing → declined` for the invitee. `null` when it was not ringing. */
  async decline(
    db: Querier,
    params: { workspaceId: string; id: string; inviteeUserId: string }
  ): Promise<CallInvitation | null> {
    const result = await db.query<CallInvitationRow>(sql`
      UPDATE call_invitations SET status = 'declined', status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND id = ${params.id}
        AND invitee_user_id = ${params.inviteeUserId} AND status = 'ringing'
      RETURNING ${sql.raw(INVITATION_COLUMNS)}
    `)
    return result.rows[0] ? mapInvitation(result.rows[0]) : null
  },

  /** CAS `ringing → cancelled` by the inviter. `null` when it was not ringing. */
  async cancel(
    db: Querier,
    params: { workspaceId: string; id: string; inviterUserId: string }
  ): Promise<CallInvitation | null> {
    const result = await db.query<CallInvitationRow>(sql`
      UPDATE call_invitations SET status = 'cancelled', status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND id = ${params.id}
        AND inviter_user_id = ${params.inviterUserId} AND status = 'ringing'
      RETURNING ${sql.raw(INVITATION_COLUMNS)}
    `)
    return result.rows[0] ? mapInvitation(result.rows[0]) : null
  },

  /**
   * CAS every `ringing` invitation on a call to `cancelled` (INV-56). The caller
   * abandoned the call (last participant left, or a sweeper ended it), so every
   * outstanding ring is retracted in the same transaction. Returns the cancelled
   * rows so the service can settle each one; a ring already terminal is skipped.
   */
  async cancelRingingForCall(db: Querier, params: { workspaceId: string; callId: string }): Promise<CallInvitation[]> {
    const result = await db.query<CallInvitationRow>(sql`
      UPDATE call_invitations SET status = 'cancelled', status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND call_id = ${params.callId} AND status = 'ringing'
      RETURNING ${sql.raw(INVITATION_COLUMNS)}
    `)
    return result.rows.map(mapInvitation)
  },

  /**
   * CAS every `ringing` invitation on a call whose inviter is the given user to
   * `cancelled`: an inviter leaving a DM call abandons their outgoing ring even
   * when other participants remain. Returns the cancelled rows.
   */
  async cancelRingingByInviter(
    db: Querier,
    params: { workspaceId: string; callId: string; inviterUserId: string }
  ): Promise<CallInvitation[]> {
    const result = await db.query<CallInvitationRow>(sql`
      UPDATE call_invitations SET status = 'cancelled', status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND call_id = ${params.callId}
        AND inviter_user_id = ${params.inviterUserId} AND status = 'ringing'
      RETURNING ${sql.raw(INVITATION_COLUMNS)}
    `)
    return result.rows.map(mapInvitation)
  },

  /**
   * Batch cancel for the sweeper cascades (INV-56): CAS every `ringing`
   * invitation across the given calls to `cancelled` in one statement, when those
   * calls just graced/ended with no live participant. Cancelling here (rather than
   * letting the ring lapse to `expired`) is what keeps an abandoned call from
   * landing a spurious missed-call activity. Workspace-agnostic, matching the
   * other sweeper batch methods (call ids are globally-unique ULIDs).
   */
  async cancelRingingForCalls(db: Querier, callIds: readonly string[]): Promise<CallInvitation[]> {
    if (callIds.length === 0) return []
    const result = await db.query<CallInvitationRow>(sql`
      UPDATE call_invitations SET status = 'cancelled', status_changed_at = NOW()
      WHERE call_id = ANY(${callIds as string[]}) AND status = 'ringing'
      RETURNING ${sql.raw(INVITATION_COLUMNS)}
    `)
    return result.rows.map(mapInvitation)
  },

  /** Set-based ring expiry (INV-56): `ringing → expired` past `expires_at`. */
  async expireStaleRings(db: Querier, now: Date): Promise<CallInvitation[]> {
    const result = await db.query<CallInvitationRow>(sql`
      UPDATE call_invitations SET status = 'expired', status_changed_at = NOW()
      WHERE status = 'ringing' AND expires_at <= ${now}
      RETURNING ${sql.raw(INVITATION_COLUMNS)}
    `)
    return result.rows.map(mapInvitation)
  },
}

// ── call_participants ─────────────────────────────────────────────────────────

interface CallParticipantRow {
  id: string
  workspace_id: string
  call_id: string
  user_id: string
  status: string
  invited_by: string | null
  removed_by: string | null
  joined_at: Date
  left_at: Date | null
  status_changed_at: Date
  created_at: Date
  updated_at: Date
}

export interface CallParticipant {
  id: string
  workspaceId: string
  callId: string
  userId: string
  status: CallParticipantStatus
  invitedBy: string | null
  removedBy: string | null
  joinedAt: Date
  leftAt: Date | null
  statusChangedAt: Date
  createdAt: Date
  updatedAt: Date
}

const PARTICIPANT_COLUMNS = `
  id, workspace_id, call_id, user_id, status, invited_by, removed_by,
  joined_at, left_at, status_changed_at, created_at, updated_at
`

function mapParticipant(row: CallParticipantRow): CallParticipant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    userId: row.user_id,
    status: row.status as CallParticipantStatus,
    invitedBy: row.invited_by,
    removedBy: row.removed_by,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const CallParticipantRepository = {
  /**
   * Actor-conditional membership admission (INV-20). A first join inserts a
   * `joined` row; a `left` participant rejoins (fresh `joined_at`); a `joined`
   * participant is idempotent. A `removed` participant is NOT revived — the
   * `ON CONFLICT` update predicate excludes `removed`, so the statement returns
   * no row, and the caller reads that as the removed-rejoin rejection. Only a
   * fresh invitation by another member (a new grant) may revive a removed user,
   * which is a later-PR path.
   */
  async admit(
    db: Querier,
    params: { id: string; workspaceId: string; callId: string; userId: string; invitedBy: string | null }
  ): Promise<CallParticipant | null> {
    const result = await db.query<CallParticipantRow>(sql`
      INSERT INTO call_participants (id, workspace_id, call_id, user_id, status, invited_by)
      VALUES (${params.id}, ${params.workspaceId}, ${params.callId}, ${params.userId}, 'joined', ${params.invitedBy})
      ON CONFLICT (workspace_id, call_id, user_id) DO UPDATE SET
        status = 'joined',
        joined_at = CASE WHEN call_participants.status = 'left' THEN NOW() ELSE call_participants.joined_at END,
        left_at = NULL,
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE call_participants.status <> 'removed'
      RETURNING ${sql.raw(PARTICIPANT_COLUMNS)}
    `)
    return result.rows[0] ? mapParticipant(result.rows[0]) : null
  },

  async findByUser(db: Querier, workspaceId: string, callId: string, userId: string): Promise<CallParticipant | null> {
    const result = await db.query<CallParticipantRow>(sql`
      SELECT ${sql.raw(PARTICIPANT_COLUMNS)} FROM call_participants
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId} AND user_id = ${userId}
    `)
    return result.rows[0] ? mapParticipant(result.rows[0]) : null
  },

  /**
   * Count currently-joined participants, optionally excluding one user. The
   * capacity gate counts everyone but the joining user, so a rejoin by an
   * already-joined user never trips the cap.
   */
  async countJoined(
    db: Querier,
    workspaceId: string,
    callId: string,
    options: { excludeUserId?: string } = {}
  ): Promise<number> {
    const exclude = options.excludeUserId ?? null
    const result = await db.query<{ count: string }>(sql`
      SELECT COUNT(*)::int AS count FROM call_participants
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId} AND status = 'joined'
        AND (${exclude}::text IS NULL OR user_id <> ${exclude})
    `)
    return Number(result.rows[0]?.count ?? 0)
  },

  /**
   * CAS a participant to `left` only when they hold no live endpoint (a leave
   * from one of several devices keeps the participant joined). `null` when the
   * participant still has a live endpoint or is not `joined`.
   */
  async markLeftIfNoLiveEndpoint(
    db: Querier,
    params: { workspaceId: string; callId: string; userId: string }
  ): Promise<CallParticipant | null> {
    const result = await db.query<CallParticipantRow>(sql`
      UPDATE call_participants p SET
        status = 'left', left_at = NOW(), status_changed_at = NOW(), updated_at = NOW()
      WHERE p.workspace_id = ${params.workspaceId} AND p.call_id = ${params.callId}
        AND p.user_id = ${params.userId} AND p.status = 'joined'
        AND NOT EXISTS (
          SELECT 1 FROM call_endpoints e
          WHERE e.workspace_id = p.workspace_id AND e.participant_id = p.id AND e.status IN ('connected', 'reconnecting')
        )
      RETURNING ${sql.raw(PARTICIPANT_COLUMNS)}
    `)
    return result.rows[0] ? mapParticipant(result.rows[0]) : null
  },

  /**
   * Batch cascade for the endpoint reaper (INV-56): CAS the named participants
   * to `left` once none of their endpoints is live. Returns the affected rows so
   * the sweeper can decide which calls to grace.
   */
  async markLeftWhereNoLiveEndpoint(db: Querier, participantIds: readonly string[]): Promise<CallParticipant[]> {
    if (participantIds.length === 0) return []
    const result = await db.query<CallParticipantRow>(sql`
      UPDATE call_participants p SET
        status = 'left', left_at = NOW(), status_changed_at = NOW(), updated_at = NOW()
      WHERE p.id = ANY(${participantIds as string[]}) AND p.status = 'joined'
        AND NOT EXISTS (
          SELECT 1 FROM call_endpoints e
          WHERE e.workspace_id = p.workspace_id AND e.participant_id = p.id AND e.status IN ('connected', 'reconnecting')
        )
      RETURNING ${sql.raw(PARTICIPANT_COLUMNS)}
    `)
    return result.rows.map(mapParticipant)
  },

  /**
   * CAS a non-removed participant to `removed`, recording who removed them. The
   * removal is terminal for the removed actor — self-rejoin is rejected by
   * {@link admit}; only a fresh invitation may revive them. `null` when already
   * removed or absent.
   */
  async remove(
    db: Querier,
    params: { workspaceId: string; callId: string; targetUserId: string; removedBy: string }
  ): Promise<CallParticipant | null> {
    const result = await db.query<CallParticipantRow>(sql`
      UPDATE call_participants SET
        status = 'removed', removed_by = ${params.removedBy}, left_at = NOW(),
        status_changed_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND call_id = ${params.callId}
        AND user_id = ${params.targetUserId} AND status IN ('joined', 'left')
      RETURNING ${sql.raw(PARTICIPANT_COLUMNS)}
    `)
    return result.rows[0] ? mapParticipant(result.rows[0]) : null
  },

  /**
   * The versioned roster's per-participant rows: every currently-joined
   * participant with their single live endpoint's connection status, server-owned
   * media state, and published-track registry (LEFT JOIN — a participant momentarily
   * without a live endpoint still appears). CF pushes no track notifications, so this
   * registry is how peers learn what to pull. Read alongside `calls.roster_version`
   * for the snapshot version.
   */
  /**
   * Distinct UserIds of everyone who was EVER a participant on each of `callIds`
   * (any status), keyed by call id — the `call_ended` card's avatar set. Batched
   * (INV-56) so the grace-end sweep can end many calls in one read.
   */
  async listUserIdsByCall(
    db: Querier,
    workspaceId: string,
    callIds: readonly string[]
  ): Promise<Map<string, string[]>> {
    const byCall = new Map<string, string[]>()
    if (callIds.length === 0) return byCall
    const result = await db.query<{ call_id: string; user_id: string }>(sql`
      SELECT call_id, user_id
      FROM call_participants
      WHERE workspace_id = ${workspaceId} AND call_id = ANY(${callIds as string[]})
      ORDER BY joined_at ASC
    `)
    for (const row of result.rows) {
      const list = byCall.get(row.call_id)
      if (list) {
        if (!list.includes(row.user_id)) list.push(row.user_id)
      } else {
        byCall.set(row.call_id, [row.user_id])
      }
    }
    return byCall
  },

  async listRoster(db: Querier, workspaceId: string, callId: string): Promise<CallRosterEntry[]> {
    const result = await db.query<{
      user_id: string
      participant_status: string
      endpoint_id: string | null
      connection_status: string | null
      cf_session_id: string | null
      media_state: MediaState | null
      published_tracks: PublishedTrack[] | null
    }>(sql`
      SELECT
        p.user_id,
        p.status AS participant_status,
        e.id AS endpoint_id,
        e.status AS connection_status,
        e.cf_session_id AS cf_session_id,
        e.media_state,
        e.published_tracks
      FROM call_participants p
      LEFT JOIN call_endpoints e
        ON e.workspace_id = p.workspace_id AND e.participant_id = p.id
        AND e.status IN ('connected', 'reconnecting')
      WHERE p.workspace_id = ${workspaceId} AND p.call_id = ${callId} AND p.status = 'joined'
      ORDER BY p.joined_at ASC
    `)
    return result.rows.map((row) => ({
      userId: row.user_id,
      participantStatus: row.participant_status as CallParticipantStatus,
      endpointId: row.endpoint_id,
      connectionStatus: row.connection_status as CallEndpointStatus | null,
      cfSessionId: row.cf_session_id,
      mediaState: row.media_state ?? {},
      publishedTracks: row.published_tracks ?? [],
    }))
  },
}

/** One participant's row in the versioned roster snapshot (see `listRoster`). */
export interface CallRosterEntry {
  userId: string
  participantStatus: CallParticipantStatus
  endpointId: string | null
  connectionStatus: CallEndpointStatus | null
  cfSessionId: string | null
  mediaState: MediaState
  publishedTracks: PublishedTrack[]
}

// ── call_endpoints ────────────────────────────────────────────────────────────

interface CallEndpointRow {
  id: string
  workspace_id: string
  call_id: string
  participant_id: string
  epoch: number
  connection_seq: number
  status: string
  cf_session_id: string | null
  media_incarnation: string | null
  media_state: MediaState
  published_tracks: PublishedTrack[]
  lease_expires_at: Date
  created_at: Date
  status_changed_at: Date
}

export interface CallEndpoint {
  id: string
  workspaceId: string
  callId: string
  participantId: string
  epoch: number
  connectionSeq: number
  status: CallEndpointStatus
  cfSessionId: string | null
  mediaIncarnation: string | null
  mediaState: MediaState
  publishedTracks: PublishedTrack[]
  leaseExpiresAt: Date
  createdAt: Date
  statusChangedAt: Date
}

const ENDPOINT_COLUMNS = `
  id, workspace_id, call_id, participant_id, epoch, connection_seq, status,
  cf_session_id, media_incarnation, media_state, published_tracks,
  lease_expires_at, created_at, status_changed_at
`

function mapEndpoint(row: CallEndpointRow): CallEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    participantId: row.participant_id,
    epoch: row.epoch,
    connectionSeq: row.connection_seq,
    status: row.status as CallEndpointStatus,
    cfSessionId: row.cf_session_id,
    mediaIncarnation: row.media_incarnation,
    mediaState: row.media_state ?? {},
    publishedTracks: row.published_tracks ?? [],
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    statusChangedAt: row.status_changed_at,
  }
}

export const CallEndpointRepository = {
  async insert(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      callId: string
      participantId: string
      epoch: number
      mediaIncarnation: string | null
      leaseExpiresAt: Date
    }
  ): Promise<CallEndpoint> {
    const result = await db.query<CallEndpointRow>(sql`
      INSERT INTO call_endpoints (
        id, workspace_id, call_id, participant_id, epoch, status, media_incarnation, lease_expires_at
      )
      VALUES (${params.id}, ${params.workspaceId}, ${params.callId}, ${params.participantId},
              ${params.epoch}, 'connected', ${params.mediaIncarnation}, ${params.leaseExpiresAt})
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return mapEndpoint(result.rows[0])
  },

  /**
   * Re-bind a participant's existing live endpoint to a (possibly new)
   * incarnation on a reconnect/reload: CAS a live endpoint back to `connected`,
   * set the incoming incarnation, and renew the lease — keeping the same row and
   * epoch (the lease is the authority, INV — a transient socket drop or a reload
   * within the lease returns to the same endpoint). `null` when the endpoint is
   * no longer live.
   *
   * A reload mints a NEW incarnation, so its old `cf_session_id`/`published_tracks`
   * belong to a dead peer connection the reloaded page can no longer drive; clear
   * both when the incoming incarnation differs from the stored one so
   * `createEndpointCfSession` mints a fresh session instead of short-circuiting on
   * the stale id. A same-incarnation transient reconnect keeps both. `IS DISTINCT
   * FROM` reads the pre-update `media_incarnation` (Postgres evaluates SET
   * expressions against the old row).
   *
   * `connection_seq` bumps on every bind (INV-66): a fast same-incarnation
   * reconnect rebinds to `connected` at the same epoch before the old socket's
   * fire-and-forget demotion commits; the demotion's (epoch, status) fence would
   * still match and wedge the endpoint at `reconnecting`, so `markReconnecting`
   * additionally fences on the seq the socket bound at — advancing it here makes
   * the stale demotion a no-op.
   */
  async rebind(
    db: Querier,
    params: { workspaceId: string; id: string; mediaIncarnation: string | null; leaseExpiresAt: Date }
  ): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET
        status = 'connected',
        media_incarnation = ${params.mediaIncarnation},
        cf_session_id = CASE
          WHEN media_incarnation IS DISTINCT FROM ${params.mediaIncarnation} THEN NULL
          ELSE cf_session_id END,
        published_tracks = CASE
          WHEN media_incarnation IS DISTINCT FROM ${params.mediaIncarnation} THEN '[]'::jsonb
          ELSE published_tracks END,
        connection_seq = connection_seq + 1,
        lease_expires_at = ${params.leaseExpiresAt},
        status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND id = ${params.id}
        AND status IN ('connected', 'reconnecting')
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /**
   * Fenced `connected → reconnecting` on a socket disconnect (INV-66): the lease
   * still holds the slot, so a reconnect within it re-binds. Fenced on the
   * `connection_seq` the disconnecting socket bound at — a faster same-incarnation
   * reconnect bumps the seq via {@link rebind}, so this stale demotion matches
   * nothing and cannot wedge the freshly re-bound endpoint at `reconnecting`. The
   * epoch fence is retained as belt for the superseded-instance case. `null` when
   * nothing matched.
   */
  async markReconnecting(
    db: Querier,
    params: { workspaceId: string; id: string; epoch: number; connectionSeq: number }
  ): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET status = 'reconnecting', status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND id = ${params.id} AND epoch = ${params.epoch}
        AND connection_seq = ${params.connectionSeq} AND status = 'connected'
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /**
   * CAS the CF session id onto a live endpoint, fenced on the incarnation
   * (INV-66) and only when none is set yet — so a committed row can never claim
   * a `cf_session_id` for a superseded incarnation. `null` when the endpoint is
   * gone, the incarnation no longer matches, or a session was already set (the
   * caller re-reads to distinguish idempotency from a stale fence).
   */
  async setCfSessionIfUnset(
    db: Querier,
    params: { workspaceId: string; id: string; mediaIncarnation: string; cfSessionId: string }
  ): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET cf_session_id = ${params.cfSessionId}, status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND id = ${params.id}
        AND media_incarnation = ${params.mediaIncarnation}
        AND status IN ('connected', 'reconnecting') AND cf_session_id IS NULL
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /**
   * Overwrite the server-owned media state (mute/camera claims), fenced on
   * `media_incarnation` (INV-66): a stale incarnation that passed `fenceEndpoint`
   * before a rebind cannot write its state onto the NEW incarnation after its CF
   * call returns. `null` when the endpoint is gone or the incarnation moved on.
   */
  async setMediaState(
    db: Querier,
    params: { workspaceId: string; id: string; mediaIncarnation: string; mediaState: MediaState }
  ): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET media_state = ${JSON.stringify(params.mediaState)}::jsonb, status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND id = ${params.id}
        AND media_incarnation = ${params.mediaIncarnation}
        AND status IN ('connected', 'reconnecting')
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /**
   * Overwrite the published-track registry, fenced on `media_incarnation`
   * (INV-66): the post-CF registry write of a stale incarnation must not land on
   * the incarnation that replaced it. `null` when the endpoint is gone or the
   * incarnation moved on.
   */
  async setPublishedTracks(
    db: Querier,
    params: { workspaceId: string; id: string; mediaIncarnation: string; publishedTracks: PublishedTrack[] }
  ): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET published_tracks = ${JSON.stringify(params.publishedTracks)}::jsonb, status_changed_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND id = ${params.id}
        AND media_incarnation = ${params.mediaIncarnation}
        AND status IN ('connected', 'reconnecting')
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /** Read an endpoint by id, workspace-scoped (INV-8). Used to verify leave ownership. */
  async findById(db: Querier, workspaceId: string, id: string): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      SELECT ${sql.raw(ENDPOINT_COLUMNS)} FROM call_endpoints
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /** The participant's current live endpoint, if any (second-device arbitration). */
  async findLiveByParticipant(db: Querier, workspaceId: string, participantId: string): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      SELECT ${sql.raw(ENDPOINT_COLUMNS)} FROM call_endpoints
      WHERE workspace_id = ${workspaceId} AND participant_id = ${participantId}
        AND status IN ('connected', 'reconnecting')
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /**
   * Every live endpoint on a call (connected/reconnecting), workspace-scoped
   * (INV-8). The pull authorization set: a pull ref is only honored when its
   * `(cf_session_id, trackName)` belongs to a live endpoint of THIS call, so a
   * hostile participant cannot replay a `cfSessionId` learned from another call.
   */
  async listLiveByCall(db: Querier, workspaceId: string, callId: string): Promise<CallEndpoint[]> {
    const result = await db.query<CallEndpointRow>(sql`
      SELECT ${sql.raw(ENDPOINT_COLUMNS)} FROM call_endpoints
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId}
        AND status IN ('connected', 'reconnecting')
    `)
    return result.rows.map(mapEndpoint)
  },

  /** Highest epoch ever issued to a participant (over all endpoints), or 0. */
  async maxEpochForParticipant(db: Querier, workspaceId: string, participantId: string): Promise<number> {
    const result = await db.query<{ max_epoch: number | null }>(sql`
      SELECT MAX(epoch) AS max_epoch FROM call_endpoints
      WHERE workspace_id = ${workspaceId} AND participant_id = ${participantId}
    `)
    return result.rows[0]?.max_epoch ?? 0
  },

  /** Close a specific endpoint (takeover / leave). `null` when absent or already closed. */
  async close(db: Querier, workspaceId: string, id: string): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET status = 'closed', status_changed_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${id} AND status IN ('connected', 'reconnecting')
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /** Close every live endpoint of a participant (removal cascade). Returns the closed rows. */
  async closeByParticipant(db: Querier, workspaceId: string, participantId: string): Promise<CallEndpoint[]> {
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET status = 'closed', status_changed_at = NOW()
      WHERE workspace_id = ${workspaceId} AND participant_id = ${participantId}
        AND status IN ('connected', 'reconnecting')
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows.map(mapEndpoint)
  },

  /**
   * Fenced lease renewal (INV-20 identity pinning, INV-66): a single UPDATE
   * guarded on `(id, epoch, live status)`. A stale incarnation carrying a
   * superseded epoch matches nothing and cannot resurrect a closed endpoint.
   */
  async renewLease(
    db: Querier,
    params: { workspaceId: string; id: string; epoch: number; leaseExpiresAt: Date }
  ): Promise<CallEndpoint | null> {
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET lease_expires_at = ${params.leaseExpiresAt}
      WHERE workspace_id = ${params.workspaceId} AND id = ${params.id} AND epoch = ${params.epoch}
        AND status IN ('connected', 'reconnecting')
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null
  },

  /**
   * First pass of the lease reaper: the distinct call ids that own a lapsed live
   * endpoint, read WITHOUT locking so the reaper can lock those call rows first
   * (call→endpoint order) before closing the endpoints under the lock.
   */
  async findLapsedCallIds(db: Querier, now: Date): Promise<string[]> {
    const result = await db.query<{ call_id: string }>(sql`
      SELECT DISTINCT call_id FROM call_endpoints
      WHERE status IN ('connected', 'reconnecting') AND lease_expires_at <= ${now}
    `)
    return result.rows.map((r) => r.call_id)
  },

  /**
   * Set-based lease reaping (INV-56): close every live endpoint past its lease on
   * the given calls in one statement. Scoped to `callIds` — the rows the reaper
   * has already locked FOR UPDATE — so it only ever writes endpoints whose call
   * it holds (call→endpoint lock order). Returns the closed rows so the sweeper
   * can cascade participant/call state.
   */
  async reapLapsed(db: Querier, now: Date, callIds: readonly string[]): Promise<CallEndpoint[]> {
    if (callIds.length === 0) return []
    const result = await db.query<CallEndpointRow>(sql`
      UPDATE call_endpoints SET status = 'closed', status_changed_at = NOW()
      WHERE call_id = ANY(${callIds as string[]})
        AND status IN ('connected', 'reconnecting') AND lease_expires_at <= ${now}
      RETURNING ${sql.raw(ENDPOINT_COLUMNS)}
    `)
    return result.rows.map(mapEndpoint)
  },
}
