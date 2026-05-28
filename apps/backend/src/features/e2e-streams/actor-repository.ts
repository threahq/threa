import type { Querier } from "../../db"
import { sql } from "../../db"
import type { E2eActorKind } from "@threa/types"

interface E2eStreamActorRow {
  kind: E2eActorKind
  key_id: string | null
}

export interface E2eStreamActor {
  kind: E2eActorKind
  keyId: string | null
}

function mapRow(row: E2eStreamActorRow): E2eStreamActor {
  return { kind: row.kind, keyId: row.key_id }
}

export const E2eStreamActorsRepository = {
  async listForStream(db: Querier, workspaceId: string, streamId: string): Promise<E2eStreamActor[]> {
    const result = await db.query<E2eStreamActorRow>(sql`
      SELECT kind, key_id
      FROM e2e_stream_actors
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      ORDER BY added_at
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Invite an actor of `kind` into an E2E stream. Race-safe (INV-20): the
   * insert is idempotent per (workspace, stream, kind). Returns true when a
   * new actor row was created, false when that kind was already invited.
   */
  async add(
    db: Querier,
    workspaceId: string,
    streamId: string,
    kind: E2eActorKind,
    keyId: string | null
  ): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO e2e_stream_actors (workspace_id, stream_id, kind, key_id)
      VALUES (${workspaceId}, ${streamId}, ${kind}, ${keyId})
      ON CONFLICT (workspace_id, stream_id, kind) DO NOTHING
    `)
    return (result.rowCount ?? 0) > 0
  },

  async remove(db: Querier, workspaceId: string, streamId: string, kind: E2eActorKind): Promise<void> {
    await db.query(sql`
      DELETE FROM e2e_stream_actors
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND kind = ${kind}
    `)
  },
}
