import type { CallMediaTransport, CallTransferPhase } from "@threahq/types"
import type { Querier } from "../../db"
import { sql } from "../../db"
import type { PublishedTrack } from "./config"

export type TransferSessionStatus = "preparing" | "ready" | "active" | "draining" | "closed" | "failed"
export interface CallTransportTransferRow {
  id: string
  workspaceId: string
  callId: string
  generation: number
  sourceGeneration: number
  sourceTransport: CallMediaTransport
  targetGeneration: number
  targetTransport: CallMediaTransport
  membershipRevision: number
  phase: CallTransferPhase
  cause: "explicit"
  idempotencyKey: string
  requestedBy: string
  prepareDeadline: Date | null
  recoveryDeadline: Date | null
  failureCode: string | null
  recoveryCode: string | null
  version: number
}
export interface CallTransportSessionRow {
  id: string
  workspaceId: string
  callId: string
  endpointId: string
  endpointEpoch: number
  mediaIncarnation: string
  transportGeneration: number
  mediaTransport: CallMediaTransport
  status: TransferSessionStatus
  providerSessionId: string | null
  publicationRevision: number
  publishedTracks: PublishedTrack[]
  failureCode: string | null
  version: number
}
export interface CallTransferObligationRow {
  id: string
  workspaceId: string
  transferId: string
  callId: string
  endpointId: string
  endpointEpoch: number
  mediaIncarnation: string
  membershipRevision: number
  trackRevision: number
  expectedPublications: unknown[]
  readyPublications: unknown[]
  ownPublicationsReady: boolean
  switched: boolean
  sourceReleased: boolean
  restoredToSource: boolean
  version: number
}

const TRANSFER_COLUMNS = `id, workspace_id, call_id, generation, source_generation, source_transport,
  target_generation, target_transport, membership_revision, phase, cause, idempotency_key, requested_by,
  prepare_deadline, recovery_deadline, failure_code, recovery_code, version`
const SESSION_COLUMNS = `id, workspace_id, call_id, endpoint_id, endpoint_epoch, media_incarnation,
  transport_generation, media_transport, status, provider_session_id, publication_revision,
  published_tracks, failure_code, version`
const OBLIGATION_COLUMNS = `id, workspace_id, transfer_id, call_id, endpoint_id, endpoint_epoch,
  media_incarnation, membership_revision, track_revision, expected_publications, ready_publications,
  own_publications_ready, switched, source_released, restored_to_source, version`

function transfer(row: Record<string, any>): CallTransportTransferRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    generation: row.generation,
    sourceGeneration: row.source_generation,
    sourceTransport: row.source_transport,
    targetGeneration: row.target_generation,
    targetTransport: row.target_transport,
    membershipRevision: row.membership_revision,
    phase: row.phase,
    cause: row.cause,
    idempotencyKey: row.idempotency_key,
    requestedBy: row.requested_by,
    prepareDeadline: row.prepare_deadline,
    recoveryDeadline: row.recovery_deadline,
    failureCode: row.failure_code,
    recoveryCode: row.recovery_code,
    version: row.version,
  }
}
function session(row: Record<string, any>): CallTransportSessionRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    endpointId: row.endpoint_id,
    endpointEpoch: row.endpoint_epoch,
    mediaIncarnation: row.media_incarnation,
    transportGeneration: row.transport_generation,
    mediaTransport: row.media_transport,
    status: row.status,
    providerSessionId: row.provider_session_id,
    publicationRevision: row.publication_revision,
    publishedTracks: row.published_tracks ?? [],
    failureCode: row.failure_code,
    version: row.version,
  }
}
function obligation(row: Record<string, any>): CallTransferObligationRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    transferId: row.transfer_id,
    callId: row.call_id,
    endpointId: row.endpoint_id,
    endpointEpoch: row.endpoint_epoch,
    mediaIncarnation: row.media_incarnation,
    membershipRevision: row.membership_revision,
    trackRevision: row.track_revision,
    expectedPublications: row.expected_publications ?? [],
    readyPublications: row.ready_publications ?? [],
    ownPublicationsReady: row.own_publications_ready,
    switched: row.switched,
    sourceReleased: row.source_released,
    restoredToSource: row.restored_to_source,
    version: row.version,
  }
}

export const CallTransferRepository = {
  async maxGeneration(db: Querier, workspaceId: string, callId: string, activeGeneration: number): Promise<number> {
    const result = await db.query<{ generation: number }>(sql`
      SELECT GREATEST(${activeGeneration}, COALESCE(MAX(generation), 0), COALESCE(MAX(target_generation), 0)) AS generation
      FROM call_transport_transfers WHERE workspace_id = ${workspaceId} AND call_id = ${callId}`)
    return result.rows[0]?.generation ?? activeGeneration
  },
  async findUnsettled(db: Querier, workspaceId: string, callId: string): Promise<CallTransportTransferRow | null> {
    const result = await db.query(sql`SELECT ${sql.raw(TRANSFER_COLUMNS)} FROM call_transport_transfers
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId}
        AND phase IN ('preparing', 'committing', 'draining', 'aborting')`)
    return result.rows[0] ? transfer(result.rows[0]) : null
  },
  async findLatest(db: Querier, workspaceId: string, callId: string): Promise<CallTransportTransferRow | null> {
    const result = await db.query(sql`SELECT ${sql.raw(TRANSFER_COLUMNS)} FROM call_transport_transfers
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId} ORDER BY generation DESC LIMIT 1`)
    return result.rows[0] ? transfer(result.rows[0]) : null
  },
  async findByIdempotencyKey(
    db: Querier,
    workspaceId: string,
    callId: string,
    key: string
  ): Promise<CallTransportTransferRow | null> {
    const result = await db.query(sql`SELECT ${sql.raw(TRANSFER_COLUMNS)} FROM call_transport_transfers
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId} AND idempotency_key = ${key}`)
    return result.rows[0] ? transfer(result.rows[0]) : null
  },
  async findById(db: Querier, workspaceId: string, id: string): Promise<CallTransportTransferRow | null> {
    const result = await db.query(sql`SELECT ${sql.raw(TRANSFER_COLUMNS)} FROM call_transport_transfers
      WHERE workspace_id = ${workspaceId} AND id = ${id}`)
    return result.rows[0] ? transfer(result.rows[0]) : null
  },
  async insert(
    db: Querier,
    p: Omit<CallTransportTransferRow, "version" | "failureCode" | "recoveryCode">
  ): Promise<CallTransportTransferRow> {
    const result = await db.query(sql`INSERT INTO call_transport_transfers
      (id, workspace_id, call_id, generation, source_generation, source_transport, target_generation,
       target_transport, membership_revision, phase, cause, idempotency_key, requested_by,
       prepare_deadline, recovery_deadline)
      VALUES (${p.id}, ${p.workspaceId}, ${p.callId}, ${p.generation}, ${p.sourceGeneration},
       ${p.sourceTransport}, ${p.targetGeneration}, ${p.targetTransport}, ${p.membershipRevision}, ${p.phase},
       ${p.cause}, ${p.idempotencyKey}, ${p.requestedBy}, ${p.prepareDeadline}, ${p.recoveryDeadline})
      RETURNING ${sql.raw(TRANSFER_COLUMNS)}`)
    return transfer(result.rows[0])
  },
  async transition(
    db: Querier,
    p: {
      workspaceId: string
      id: string
      generation: number
      from: CallTransferPhase
      version: number
      to: CallTransferPhase
      failureCode?: string | null
      recoveryCode?: string | null
      recoveryDeadline?: Date | null
    }
  ): Promise<CallTransportTransferRow | null> {
    const result = await db.query(sql`UPDATE call_transport_transfers SET phase = ${p.to},
      failure_code = COALESCE(${p.failureCode ?? null}, failure_code),
      recovery_code = COALESCE(${p.recoveryCode ?? null}, recovery_code),
      recovery_deadline = COALESCE(${p.recoveryDeadline ?? null}, recovery_deadline), version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${p.workspaceId} AND id = ${p.id} AND generation = ${p.generation}
        AND phase = ${p.from} AND version = ${p.version}
      RETURNING ${sql.raw(TRANSFER_COLUMNS)}`)
    return result.rows[0] ? transfer(result.rows[0]) : null
  },
  async touch(
    db: Querier,
    p: { workspaceId: string; id: string; generation: number; version: number }
  ): Promise<CallTransportTransferRow | null> {
    const result = await db.query(sql`UPDATE call_transport_transfers SET version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${p.workspaceId} AND id = ${p.id} AND generation = ${p.generation}
      AND version = ${p.version} AND phase IN ('preparing', 'committing') RETURNING ${sql.raw(TRANSFER_COLUMNS)}`)
    return result.rows[0] ? transfer(result.rows[0]) : null
  },
  async updateMembershipRevision(
    db: Querier,
    p: { workspaceId: string; id: string; generation: number; version: number; membershipRevision: number }
  ): Promise<CallTransportTransferRow | null> {
    const result = await db.query(sql`UPDATE call_transport_transfers SET membership_revision = ${p.membershipRevision},
      version = version + 1, updated_at = NOW() WHERE workspace_id = ${p.workspaceId} AND id = ${p.id}
      AND generation = ${p.generation} AND version = ${p.version}
      AND phase IN ('preparing', 'committing', 'draining') RETURNING ${sql.raw(TRANSFER_COLUMNS)}`)
    return result.rows[0] ? transfer(result.rows[0]) : null
  },
  async listExpired(db: Querier, now: Date): Promise<CallTransportTransferRow[]> {
    const result = await db.query(sql`SELECT ${sql.raw(TRANSFER_COLUMNS)} FROM call_transport_transfers
      WHERE (phase = 'preparing' AND prepare_deadline <= ${now})
         OR (phase IN ('committing', 'draining', 'aborting') AND recovery_deadline <= ${now})
      ORDER BY call_id, generation`)
    return result.rows.map(transfer)
  },
  async markRecoveryTimedOut(
    db: Querier,
    p: { workspaceId: string; id: string; generation: number; version: number }
  ): Promise<CallTransportTransferRow | null> {
    const result = await db.query(sql`UPDATE call_transport_transfers SET recovery_code = 'RESTORE_ACK_TIMEOUT',
      recovery_deadline = NULL, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${p.workspaceId} AND id = ${p.id} AND generation = ${p.generation}
      AND version = ${p.version} AND phase = 'aborting' RETURNING ${sql.raw(TRANSFER_COLUMNS)}`)
    return result.rows[0] ? transfer(result.rows[0]) : null
  },
}

export const CallTransportSessionRepository = {
  async listByCall(db: Querier, workspaceId: string, callId: string): Promise<CallTransportSessionRow[]> {
    const result = await db.query(sql`SELECT ${sql.raw(SESSION_COLUMNS)} FROM call_transport_sessions
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId} ORDER BY transport_generation, endpoint_id`)
    return result.rows.map(session)
  },
  async find(
    db: Querier,
    p: { workspaceId: string; callId: string; endpointId: string; generation: number }
  ): Promise<CallTransportSessionRow | null> {
    const result = await db.query(sql`SELECT ${sql.raw(SESSION_COLUMNS)} FROM call_transport_sessions
      WHERE workspace_id = ${p.workspaceId} AND call_id = ${p.callId} AND endpoint_id = ${p.endpointId}
        AND transport_generation = ${p.generation} AND status <> 'closed'`)
    return result.rows[0] ? session(result.rows[0]) : null
  },
  async insert(
    db: Querier,
    p: Omit<CallTransportSessionRow, "version" | "failureCode">
  ): Promise<CallTransportSessionRow> {
    const result = await db.query(sql`INSERT INTO call_transport_sessions
      (id, workspace_id, call_id, endpoint_id, endpoint_epoch, media_incarnation, transport_generation,
       media_transport, status, provider_session_id, publication_revision, published_tracks)
      VALUES (${p.id}, ${p.workspaceId}, ${p.callId}, ${p.endpointId}, ${p.endpointEpoch}, ${p.mediaIncarnation},
       ${p.transportGeneration}, ${p.mediaTransport}, ${p.status}, ${p.providerSessionId}, ${p.publicationRevision},
       ${JSON.stringify(p.publishedTracks)}::jsonb) RETURNING ${sql.raw(SESSION_COLUMNS)}`)
    return session(result.rows[0])
  },
  async bindProviderSession(
    db: Querier,
    p: {
      workspaceId: string
      id: string
      endpointEpoch: number
      mediaIncarnation: string
      generation: number
      version: number
      providerSessionId: string
    }
  ): Promise<CallTransportSessionRow | null> {
    const result = await db.query(sql`UPDATE call_transport_sessions SET provider_session_id = ${p.providerSessionId},
      version = version + 1, updated_at = NOW() WHERE workspace_id = ${p.workspaceId} AND id = ${p.id}
      AND endpoint_epoch = ${p.endpointEpoch} AND media_incarnation = ${p.mediaIncarnation}
      AND transport_generation = ${p.generation} AND version = ${p.version} AND provider_session_id IS NULL
      AND status IN ('preparing', 'ready', 'active') RETURNING ${sql.raw(SESSION_COLUMNS)}`)
    return result.rows[0] ? session(result.rows[0]) : null
  },
  async setPublications(
    db: Querier,
    p: {
      workspaceId: string
      id: string
      endpointEpoch: number
      mediaIncarnation: string
      generation: number
      revision: number
      tracks: PublishedTrack[]
    }
  ): Promise<CallTransportSessionRow | null> {
    const result =
      await db.query(sql`UPDATE call_transport_sessions SET published_tracks = ${JSON.stringify(p.tracks)}::jsonb,
      publication_revision = ${p.revision}, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${p.workspaceId} AND id = ${p.id} AND endpoint_epoch = ${p.endpointEpoch}
      AND media_incarnation = ${p.mediaIncarnation} AND transport_generation = ${p.generation}
      AND publication_revision < ${p.revision} AND status IN ('preparing', 'ready', 'active', 'draining')
      RETURNING ${sql.raw(SESSION_COLUMNS)}`)
    return result.rows[0] ? session(result.rows[0]) : null
  },
  async closeForEndpoint(
    db: Querier,
    p: { workspaceId: string; callId: string; endpointId: string; exceptIncarnation?: string }
  ): Promise<CallTransportSessionRow[]> {
    const except = p.exceptIncarnation ?? null
    const result = await db.query(sql`UPDATE call_transport_sessions SET status = 'closed', version = version + 1,
      updated_at = NOW() WHERE workspace_id = ${p.workspaceId} AND call_id = ${p.callId}
      AND endpoint_id = ${p.endpointId} AND status <> 'closed'
      AND (${except}::text IS NULL OR media_incarnation <> ${except}) RETURNING ${sql.raw(SESSION_COLUMNS)}`)
    return result.rows.map(session)
  },
  async projectGenerationToEndpoints(
    db: Querier,
    p: { workspaceId: string; callId: string; generation: number }
  ): Promise<void> {
    await db.query(sql`UPDATE call_endpoints e SET cf_session_id = s.provider_session_id,
      publication_revision = s.publication_revision, published_tracks = s.published_tracks
      FROM call_transport_sessions s WHERE e.workspace_id = ${p.workspaceId} AND e.call_id = ${p.callId}
      AND s.workspace_id = e.workspace_id AND s.call_id = e.call_id AND s.endpoint_id = e.id
      AND s.endpoint_epoch = e.epoch AND s.media_incarnation = e.media_incarnation
      AND s.transport_generation = ${p.generation} AND s.status IN ('preparing', 'ready', 'active')`)
  },
  async closeAllForCall(db: Querier, workspaceId: string, callId: string): Promise<CallTransportSessionRow[]> {
    const result = await db.query(sql`UPDATE call_transport_sessions SET status = 'closed', version = version + 1,
      updated_at = NOW() WHERE workspace_id = ${workspaceId} AND call_id = ${callId}
      RETURNING ${sql.raw(SESSION_COLUMNS)}`)
    return result.rows.map(session)
  },
  async closeGeneration(
    db: Querier,
    p: { workspaceId: string; callId: string; generation: number }
  ): Promise<CallTransportSessionRow[]> {
    const result = await db.query(sql`UPDATE call_transport_sessions SET status = 'closed', version = version + 1,
      updated_at = NOW() WHERE workspace_id = ${p.workspaceId} AND call_id = ${p.callId}
      AND transport_generation = ${p.generation} AND status <> 'closed' RETURNING ${sql.raw(SESSION_COLUMNS)}`)
    return result.rows.map(session)
  },
  async setStatusForGeneration(
    db: Querier,
    p: {
      workspaceId: string
      callId: string
      generation: number
      from: TransferSessionStatus[]
      to: TransferSessionStatus
    }
  ): Promise<CallTransportSessionRow[]> {
    const result = await db.query(sql`UPDATE call_transport_sessions SET status = ${p.to}, version = version + 1,
      updated_at = NOW() WHERE workspace_id = ${p.workspaceId} AND call_id = ${p.callId}
      AND transport_generation = ${p.generation} AND status = ANY(${p.from}) RETURNING ${sql.raw(SESSION_COLUMNS)}`)
    return result.rows.map(session)
  },
}

export const CallTransferObligationRepository = {
  async list(db: Querier, workspaceId: string, transferId: string): Promise<CallTransferObligationRow[]> {
    const result = await db.query(sql`SELECT ${sql.raw(OBLIGATION_COLUMNS)} FROM call_transfer_obligations
      WHERE workspace_id = ${workspaceId} AND transfer_id = ${transferId} ORDER BY endpoint_id`)
    return result.rows.map(obligation)
  },
  async insert(
    db: Querier,
    p: Omit<
      CallTransferObligationRow,
      "version" | "readyPublications" | "ownPublicationsReady" | "switched" | "sourceReleased" | "restoredToSource"
    >
  ): Promise<CallTransferObligationRow> {
    const result = await db.query(sql`INSERT INTO call_transfer_obligations
      (id, workspace_id, transfer_id, call_id, endpoint_id, endpoint_epoch, media_incarnation,
       membership_revision, track_revision, expected_publications)
      VALUES (${p.id}, ${p.workspaceId}, ${p.transferId}, ${p.callId}, ${p.endpointId}, ${p.endpointEpoch},
       ${p.mediaIncarnation}, ${p.membershipRevision}, ${p.trackRevision}, ${JSON.stringify(p.expectedPublications)}::jsonb)
      RETURNING ${sql.raw(OBLIGATION_COLUMNS)}`)
    return obligation(result.rows[0])
  },
  async acknowledgeReady(
    db: Querier,
    p: {
      workspaceId: string
      transferId: string
      endpointId: string
      endpointEpoch: number
      mediaIncarnation: string
      membershipRevision: number
      trackRevision: number
      readyPublications: unknown[]
    }
  ): Promise<CallTransferObligationRow | null> {
    const result = await db.query(sql`UPDATE call_transfer_obligations SET own_publications_ready = TRUE,
      ready_publications = ${JSON.stringify(p.readyPublications)}::jsonb, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${p.workspaceId} AND transfer_id = ${p.transferId} AND endpoint_id = ${p.endpointId}
      AND endpoint_epoch = ${p.endpointEpoch} AND media_incarnation = ${p.mediaIncarnation}
      AND membership_revision = ${p.membershipRevision} AND track_revision = ${p.trackRevision}
      RETURNING ${sql.raw(OBLIGATION_COLUMNS)}`)
    return result.rows[0] ? obligation(result.rows[0]) : null
  },
  async acknowledgeSwitched(
    db: Querier,
    p: {
      workspaceId: string
      transferId: string
      endpointId: string
      endpointEpoch: number
      mediaIncarnation: string
      membershipRevision: number
      trackRevision: number
    }
  ): Promise<CallTransferObligationRow | null> {
    const result = await db.query(sql`UPDATE call_transfer_obligations SET switched = TRUE, switched_at = NOW(),
      version = version + 1, updated_at = NOW() WHERE workspace_id = ${p.workspaceId} AND transfer_id = ${p.transferId}
      AND endpoint_id = ${p.endpointId} AND endpoint_epoch = ${p.endpointEpoch}
      AND media_incarnation = ${p.mediaIncarnation} AND membership_revision = ${p.membershipRevision}
      AND track_revision = ${p.trackRevision} RETURNING ${sql.raw(OBLIGATION_COLUMNS)}`)
    return result.rows[0] ? obligation(result.rows[0]) : null
  },
  async revisePublisherKind(
    db: Querier,
    p: {
      workspaceId: string
      transferId: string
      publisherEndpointId: string
      kind: "mic" | "camera"
      expected: unknown[]
      publisherTrackRevision: number
    }
  ): Promise<void> {
    await db.query(sql`UPDATE call_transfer_obligations SET
      expected_publications = CASE WHEN endpoint_id = ${p.publisherEndpointId} THEN expected_publications ELSE
        COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(expected_publications) item
          WHERE item->>'endpointId' <> ${p.publisherEndpointId} OR item->>'kind' <> ${p.kind}), '[]'::jsonb) || ${JSON.stringify(p.expected)}::jsonb END,
      ready_publications = CASE WHEN endpoint_id = ${p.publisherEndpointId} THEN ready_publications ELSE
        COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(ready_publications) item
          WHERE item->>'endpointId' <> ${p.publisherEndpointId} OR item->>'kind' <> ${p.kind}), '[]'::jsonb) END,
      own_publications_ready = CASE WHEN endpoint_id = ${p.publisherEndpointId} THEN FALSE ELSE own_publications_ready END,
      track_revision = CASE WHEN endpoint_id = ${p.publisherEndpointId} THEN ${p.publisherTrackRevision} ELSE track_revision END,
      switched = FALSE, restored_to_source = FALSE, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${p.workspaceId} AND transfer_id = ${p.transferId}`)
  },
  async replaceBarrier(db: Querier, workspaceId: string, transferId: string): Promise<void> {
    await db.query(
      sql`DELETE FROM call_transfer_obligations WHERE workspace_id = ${workspaceId} AND transfer_id = ${transferId}`
    )
  },
  async acknowledgeRestored(
    db: Querier,
    p: {
      workspaceId: string
      transferId: string
      endpointId: string
      endpointEpoch: number
      mediaIncarnation: string
      membershipRevision: number
      trackRevision: number
    }
  ): Promise<CallTransferObligationRow | null> {
    const result = await db.query(sql`UPDATE call_transfer_obligations SET restored_to_source = TRUE,
      restored_to_source_at = COALESCE(restored_to_source_at, NOW()), version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${p.workspaceId} AND transfer_id = ${p.transferId} AND endpoint_id = ${p.endpointId}
      AND endpoint_epoch = ${p.endpointEpoch} AND media_incarnation = ${p.mediaIncarnation}
      AND membership_revision = ${p.membershipRevision} AND track_revision = ${p.trackRevision}
      RETURNING ${sql.raw(OBLIGATION_COLUMNS)}`)
    return result.rows[0] ? obligation(result.rows[0]) : null
  },
  async markAllSourceReleased(db: Querier, workspaceId: string, transferId: string): Promise<void> {
    await db.query(sql`UPDATE call_transfer_obligations SET source_released = TRUE, source_released_at = NOW(),
      version = version + 1, updated_at = NOW() WHERE workspace_id = ${workspaceId} AND transfer_id = ${transferId}
      AND switched AND NOT source_released`)
  },
}
