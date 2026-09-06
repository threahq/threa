import type { Querier } from "../../db"
import { sql } from "../../db"
import { DelegationStatuses, type DelegationStatus } from "@threahq/types"

interface DelegatedTaskRow {
  id: string
  workspace_id: string
  stream_id: string
  session_id: string | null
  source_conversation_id: string | null
  created_by_kind: string
  created_by_id: string
  title: string
  brief: string
  context_refs: string[]
  status: string
  claim_token_hash: string | null
  claim_idempotency_key: string | null
  claim_expires_at: Date | null
  claimed_by_label: string | null
  result_message_id: string | null
  status_note: string | null
  created_at: Date
  updated_at: Date
  status_changed_at: Date
}

export interface DelegatedTask {
  id: string
  workspaceId: string
  streamId: string
  sessionId: string | null
  sourceConversationId: string | null
  createdByKind: string
  createdById: string
  title: string
  brief: string
  contextRefs: string[]
  status: DelegationStatus
  claimTokenHash: string | null
  claimIdempotencyKey: string | null
  claimExpiresAt: Date | null
  claimedByLabel: string | null
  resultMessageId: string | null
  statusNote: string | null
  createdAt: Date
  updatedAt: Date
  statusChangedAt: Date
}

export interface InsertDelegatedTaskParams {
  id: string
  workspaceId: string
  streamId: string
  sessionId: string | null
  sourceConversationId: string | null
  createdByKind: string
  createdById: string
  title: string
  brief: string
  contextRefs: string[]
}

const COLUMNS = `
  id, workspace_id, stream_id, session_id, source_conversation_id,
  created_by_kind, created_by_id, title, brief, context_refs,
  status, claim_token_hash, claim_idempotency_key, claim_expires_at, claimed_by_label,
  result_message_id, status_note, created_at, updated_at, status_changed_at
`

const QUALIFIED_COLUMNS = COLUMNS.split(",")
  .map((column) => `dt.${column.trim()}`)
  .join(", ")

/** A delegation plus its `delegation:created` timeline event id, for deep-linking the card. */
export interface DelegatedTaskWithEvent extends DelegatedTask {
  createdEventId: string | null
}

function mapRow(row: DelegatedTaskRow): DelegatedTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    sessionId: row.session_id,
    sourceConversationId: row.source_conversation_id,
    createdByKind: row.created_by_kind,
    createdById: row.created_by_id,
    title: row.title,
    brief: row.brief,
    contextRefs: row.context_refs,
    status: row.status as DelegationStatus,
    claimTokenHash: row.claim_token_hash,
    claimIdempotencyKey: row.claim_idempotency_key,
    claimExpiresAt: row.claim_expires_at,
    claimedByLabel: row.claimed_by_label,
    resultMessageId: row.result_message_id,
    statusNote: row.status_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
  }
}

// Every claim-authenticated transition (heartbeat, running, complete, fail)
// repeats the same live-holder guard inline —
//   status IN ('claimed','running') AND claim_token_hash = $x AND claim_expires_at > NOW()
// — so a lapsed or stolen claim CASes to nothing instead of acting on a task
// someone else now holds. (Inline rather than a shared fragment: squid's `sql`
// tag can't nest fragments alongside `sql.raw`.)
export const DelegatedTaskRepository = {
  async insert(db: Querier, params: InsertDelegatedTaskParams): Promise<DelegatedTask> {
    const result = await db.query<DelegatedTaskRow>(sql`
      INSERT INTO delegated_tasks (
        id, workspace_id, stream_id, session_id, source_conversation_id,
        created_by_kind, created_by_id, title, brief, context_refs, status
      ) VALUES (
        ${params.id}, ${params.workspaceId}, ${params.streamId}, ${params.sessionId},
        ${params.sourceConversationId}, ${params.createdByKind}, ${params.createdById},
        ${params.title}, ${params.brief}, ${JSON.stringify(params.contextRefs)},
        ${DelegationStatuses.OPEN}
      )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return mapRow(result.rows[0])
  },

  /** Read a single delegation by id, workspace-scoped (INV-8). */
  async findById(db: Querier, workspaceId: string, id: string): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM delegated_tasks
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Read a single delegation plus its `delegation:created` event id,
   * workspace-scoped (INV-8) — the first-party by-id GET and the link-preview
   * resolver, both of which deep-link the card. Mirrors `listByStream`'s join.
   */
  async findByIdWithEvent(db: Querier, workspaceId: string, id: string): Promise<DelegatedTaskWithEvent | null> {
    const result = await db.query<DelegatedTaskRow & { created_event_id: string | null }>(sql`
      SELECT ${sql.raw(QUALIFIED_COLUMNS)}, ce.id AS created_event_id
      FROM delegated_tasks dt
      LEFT JOIN stream_events ce
        ON ce.stream_id = dt.stream_id
        AND ce.event_type = 'delegation:created'
        AND ce.payload->>'delegationId' = dt.id
      WHERE dt.id = ${id} AND dt.workspace_id = ${workspaceId}
    `)
    const row = result.rows[0]
    return row ? { ...mapRow(row), createdEventId: row.created_event_id } : null
  },

  /**
   * The delegation's `delegation:created` event id — the timeline card its
   * result thread anchors on (INV-27: the targeted read the completion flow
   * needs inside its claim-locked transaction, without re-fetching the whole
   * row it already holds). Mirrors the join in `findByIdWithEvent`.
   */
  async findCreatedEventId(db: Querier, workspaceId: string, id: string): Promise<string | null> {
    const result = await db.query<{ id: string }>(sql`
      SELECT id FROM stream_events
      WHERE stream_id = (SELECT stream_id FROM delegated_tasks WHERE id = ${id} AND workspace_id = ${workspaceId})
        AND event_type = 'delegation:created'
        AND payload->>'delegationId' = ${id}
      LIMIT 1
    `)
    return result.rows[0]?.id ?? null
  },

  /**
   * A workspace's open (claimable) delegations, oldest first — the 5.3 list
   * surface. `since` narrows to rows whose availability changed after the
   * instant, so reopened old tasks appear in polling deltas.
   */
  async listOpen(db: Querier, workspaceId: string, { since }: { since?: Date } = {}): Promise<DelegatedTask[]> {
    const result = await db.query<DelegatedTaskRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM delegated_tasks
      WHERE workspace_id = ${workspaceId} AND status = ${DelegationStatuses.OPEN}
        AND (${since ?? null}::timestamptz IS NULL OR status_changed_at > ${since ?? null})
      ORDER BY created_at ASC
    `)
    return result.rows.map(mapRow)
  },

  /**
   * A stream's delegations, newest first — the member-facing list surface (the
   * "In this stream" panel). Statuses live in `delegation:status_changed`
   * patches, so a timeline-derived view goes stale outside the loaded window;
   * this read is the authority. Joins each row's `delegation:created` event so
   * the panel can deep-link the card. Bounded: the panel is a recency-biased
   * overview, not an archive.
   */
  async listByStream(
    db: Querier,
    workspaceId: string,
    streamId: string,
    { limit = 100 }: { limit?: number } = {}
  ): Promise<DelegatedTaskWithEvent[]> {
    const result = await db.query<DelegatedTaskRow & { created_event_id: string | null }>(sql`
      SELECT ${sql.raw(QUALIFIED_COLUMNS)}, ce.id AS created_event_id
      FROM delegated_tasks dt
      LEFT JOIN stream_events ce
        ON ce.stream_id = dt.stream_id
        AND ce.event_type = 'delegation:created'
        AND ce.payload->>'delegationId' = dt.id
      WHERE dt.workspace_id = ${workspaceId} AND dt.stream_id = ${streamId}
      ORDER BY dt.created_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map((row) => ({ ...mapRow(row), createdEventId: row.created_event_id }))
  },

  /**
   * CAS `open → claimed`, binding the claim to `claimTokenHash` under a TTL.
   * Exactly one concurrent claimer wins the status guard; the rest (and any
   * claim racing a cancel) get `null`.
   */
  async claim(
    db: Querier,
    params: {
      workspaceId: string
      id: string
      claimTokenHash: string
      claimIdempotencyKey: string | null
      claimedByLabel: string
      ttlSeconds: number
    }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.CLAIMED},
        claim_token_hash = ${params.claimTokenHash},
        claim_idempotency_key = ${params.claimIdempotencyKey},
        claim_expires_at = NOW() + (${params.ttlSeconds} || ' seconds')::interval,
        claimed_by_label = ${params.claimedByLabel},
        status_note = NULL,
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status IN (${DelegationStatuses.OPEN}, ${DelegationStatuses.EXPIRED})
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Re-key a claim whose one-time token was lost (crash between the claim
   * response and persisting the token). CAS-guarded on the SAME idempotency
   * key the original claim carried — the runner persists that key BEFORE
   * claiming, so only the original claimer can re-key. Mints nothing itself:
   * the caller supplies the fresh token hash; the old token stops matching
   * immediately. Status is untouched (still claimed/running); the lease
   * restarts.
   */
  async reclaimByIdempotencyKey(
    db: Querier,
    params: { workspaceId: string; id: string; claimIdempotencyKey: string; claimTokenHash: string; ttlSeconds: number }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        claim_token_hash = ${params.claimTokenHash},
        claim_expires_at = NOW() + (${params.ttlSeconds} || ' seconds')::interval,
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status IN (${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING})
        AND claim_idempotency_key = ${params.claimIdempotencyKey}
        AND claim_expires_at > NOW()
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Push the claim's expiry forward (heartbeat). Guarded on the live claim, so
   * a lapsed claim cannot resurrect itself past the sweep.
   */
  async renewClaim(
    db: Querier,
    params: { workspaceId: string; id: string; claimTokenHash: string; ttlSeconds: number }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        claim_expires_at = NOW() + (${params.ttlSeconds} || ' seconds')::interval,
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status IN (${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING})
        AND claim_token_hash = ${params.claimTokenHash}
        AND claim_expires_at > NOW()
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `claimed|running → running`, refreshing the claim TTL (a progress
   * report is also a liveness signal) and recording the agent's note.
   * `running → running` is a legitimate repeat — each report replaces the note.
   */
  async markRunning(
    db: Querier,
    params: { workspaceId: string; id: string; claimTokenHash: string; ttlSeconds: number; statusNote: string | null }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.RUNNING},
        status_note = COALESCE(${params.statusNote}::text, status_note),
        claim_expires_at = NOW() + (${params.ttlSeconds} || ' seconds')::interval,
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status IN (${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING})
        AND claim_token_hash = ${params.claimTokenHash}
        AND claim_expires_at > NOW()
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Lock a live-claimed row for the completion flow (FOR UPDATE, same
   * live-holder guard as the transitions): the completion posts a message and
   * then CASes to `completed` in one transaction, so it validates the claim
   * BEFORE writing the message — an invalid or lapsed token does no work at
   * all, and the lock serializes complete-vs-cancel on the row. Mirrors
   * bot-invocations' `findActiveClaimForUpdate`.
   */
  async findClaimedForUpdate(
    db: Querier,
    params: { workspaceId: string; id: string; claimTokenHash: string }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM delegated_tasks
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status IN (${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING})
        AND claim_token_hash = ${params.claimTokenHash}
        AND claim_expires_at > NOW()
      FOR UPDATE
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `claimed|running → completed`, token-guarded; links the result message
   * when given. Terminal transitions clear `status_note` (here, cancel, expire —
   * `fail` overwrites it with the failure reason) so a stale progress note can
   * never render under a terminal badge on the card.
   */
  async complete(
    db: Querier,
    params: { workspaceId: string; id: string; claimTokenHash: string; resultMessageId: string | null }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.COMPLETED},
        result_message_id = ${params.resultMessageId},
        status_note = NULL,
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status IN (${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING})
        AND claim_token_hash = ${params.claimTokenHash}
        AND claim_expires_at > NOW()
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** CAS `claimed|running → failed`, token-guarded; records why. */
  async fail(
    db: Querier,
    params: { workspaceId: string; id: string; claimTokenHash: string; statusNote: string }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.FAILED},
        status_note = ${params.statusNote},
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status IN (${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING})
        AND claim_token_hash = ${params.claimTokenHash}
        AND claim_expires_at > NOW()
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS any non-terminal status → `completed`, no claim token — a person's
   * "Mark as done" from the card, for work executed outside the API loop
   * (copy-paste into a local agent, or just done by hand). Without this, the
   * only affordance for finished paste-path work was Cancel, which lies.
   * No result message is linked; the doer reports in chat like any human.
   * Optionally stream-scoped like markCancelled. Returns `null` when already
   * terminal (the mark-done lost the race).
   */
  async markDone(
    db: Querier,
    params: { workspaceId: string; id: string; streamId?: string }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.COMPLETED},
        status_note = NULL,
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND (${params.streamId ?? null}::text IS NULL OR stream_id = ${params.streamId ?? null})
        AND status IN (${DelegationStatuses.OPEN}, ${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING}, ${DelegationStatuses.EXPIRED})
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS any non-terminal status → `cancelled` (a person's action from the card
   * — no claim token; cancelling out from under a claimed agent is deliberate,
   * its next token-guarded write no-ops). Optionally stream-scoped so the
   * first-party endpoint can bind the id to the stream it was invoked from.
   * Returns `null` when the delegation already reached a terminal state.
   */
  async markCancelled(
    db: Querier,
    params: { workspaceId: string; id: string; streamId?: string }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.CANCELLED},
        status_note = NULL,
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND (${params.streamId ?? null}::text IS NULL OR stream_id = ${params.streamId ?? null})
        AND status IN (${DelegationStatuses.OPEN}, ${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING}, ${DelegationStatuses.EXPIRED})
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async requeue(
    db: Querier,
    params: { workspaceId: string; id: string; streamId?: string }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.OPEN}, claim_token_hash = NULL, claim_idempotency_key = NULL,
        claim_expires_at = NULL, claimed_by_label = NULL, status_note = NULL,
        status_changed_at = NOW(), updated_at = NOW()
      WHERE id = ${params.id} AND workspace_id = ${params.workspaceId}
        AND (${params.streamId ?? null}::text IS NULL OR stream_id = ${params.streamId ?? null})
        AND status = ${DelegationStatuses.EXPIRED}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async release(
    db: Querier,
    params: { workspaceId: string; id: string; claimTokenHash: string }
  ): Promise<DelegatedTask | null> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.OPEN}, claim_token_hash = NULL, claim_idempotency_key = NULL,
        claim_expires_at = NULL, claimed_by_label = NULL, status_note = NULL,
        status_changed_at = NOW(), updated_at = NOW()
      WHERE id = ${params.id} AND workspace_id = ${params.workspaceId}
        AND status IN (${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING})
        AND claim_token_hash = ${params.claimTokenHash} AND claim_expires_at > NOW()
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Set-based reopening (INV-56): CAS every lapsed claim to `open` in one
   * statement and return the affected rows so the sweep can append their
   * timeline events in the same transaction. The status guard makes concurrent
   * sweeps idempotent — the second one matches nothing.
   */
  async reopenLapsedClaims(db: Querier): Promise<DelegatedTask[]> {
    const result = await db.query<DelegatedTaskRow>(sql`
      UPDATE delegated_tasks SET
        status = ${DelegationStatuses.OPEN},
        claim_token_hash = NULL,
        claim_idempotency_key = NULL,
        claim_expires_at = NULL,
        claimed_by_label = NULL,
        status_note = NULL,
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE status IN (${DelegationStatuses.CLAIMED}, ${DelegationStatuses.RUNNING})
        AND claim_expires_at <= NOW()
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows.map(mapRow)
  },
}
