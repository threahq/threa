import type { Querier } from "../../db"
import { sql } from "../../db"
import type { E2eActorKind } from "@threa/types"

interface E2eStreamActorRow {
  kind: E2eActorKind
  actor_id: string
  key_id: string | null
}

export interface E2eStreamActor {
  kind: E2eActorKind
  /** The pinned principal: a bot's bot_id, or the enclave sentinel. */
  actorId: string
  keyId: string | null
}

function mapRow(row: E2eStreamActorRow): E2eStreamActor {
  return { kind: row.kind, actorId: row.actor_id, keyId: row.key_id }
}

export const E2eStreamActorsRepository = {
  async listForStream(db: Querier, workspaceId: string, streamId: string): Promise<E2eStreamActor[]> {
    const result = await db.query<E2eStreamActorRow>(sql`
      SELECT kind, actor_id, key_id
      FROM e2e_stream_actors
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      ORDER BY added_at
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Invite a specific actor (`kind` + `actorId`) into an E2E stream. Race-safe
   * (INV-20): the insert is idempotent per (workspace, stream, kind, actor_id),
   * so a scratchpad can hold multiple bots while a repeat invite of the same
   * one is a no-op. Returns true when a new actor row was created.
   */
  async add(
    db: Querier,
    workspaceId: string,
    streamId: string,
    kind: E2eActorKind,
    actorId: string,
    keyId: string | null
  ): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO e2e_stream_actors (workspace_id, stream_id, kind, actor_id, key_id)
      VALUES (${workspaceId}, ${streamId}, ${kind}, ${actorId}, ${keyId})
      ON CONFLICT (workspace_id, stream_id, kind, actor_id) DO NOTHING
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Copy every actor (enclave + bots) from `fromStreamId` onto `toStreamId` in
   * one set-based, idempotent insert (INV-56). Used when a thread inherits its
   * root scratchpad's E2E state so the enclave (and any invited bots) are
   * present on the thread and its turns dispatch the same way the root's do.
   */
  async copyToStream(
    db: Querier,
    params: { workspaceId: string; fromStreamId: string; toStreamId: string }
  ): Promise<void> {
    await db.query(sql`
      INSERT INTO e2e_stream_actors (workspace_id, stream_id, kind, actor_id, key_id, added_at)
      SELECT workspace_id, ${params.toStreamId}, kind, actor_id, key_id, added_at
      FROM e2e_stream_actors
      WHERE workspace_id = ${params.workspaceId} AND stream_id = ${params.fromStreamId}
      ON CONFLICT (workspace_id, stream_id, kind, actor_id) DO NOTHING
    `)
  },

  async remove(db: Querier, workspaceId: string, streamId: string, kind: E2eActorKind, actorId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM e2e_stream_actors
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND kind = ${kind} AND actor_id = ${actorId}
    `)
  },
}
