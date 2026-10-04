import type { ActorCopy, BridgeActor } from "@threahq/types"
import { sql, type Querier } from "../../db"

interface ActorCopyRow {
  workspace_id: string
  id: string
  origin_workspace_id: string
  name: string
  avatar_emoji: string | null
}

const COLUMNS = "workspace_id, id, origin_workspace_id, name, avatar_emoji"

function mapRow(row: ActorCopyRow): ActorCopy {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    originWorkspaceId: row.origin_workspace_id,
    name: row.name,
    avatarEmoji: row.avatar_emoji,
  }
}

export const ActorCopyRepository = {
  /**
   * Writes the origin's actors in one statement. Returns only the copies that
   * were inserted or whose name or emoji changed. A copy held under another
   * origin is left as it is and not returned.
   */
  async upsert(
    db: Querier,
    params: { workspaceId: string; originWorkspaceId: string; actors: BridgeActor[] }
  ): Promise<ActorCopy[]> {
    const actors = [...new Map(params.actors.map((actor) => [actor.id, actor])).values()]
    if (actors.length === 0) return []
    const result = await db.query<ActorCopyRow>(sql`
      INSERT INTO actor_copies (workspace_id, id, origin_workspace_id, name, avatar_emoji)
      SELECT ${params.workspaceId}, incoming.id, ${params.originWorkspaceId}, incoming.name, incoming.avatar_emoji
      FROM unnest(
        ${actors.map((actor) => actor.id)}::text[],
        ${actors.map((actor) => actor.name)}::text[],
        ${actors.map((actor) => actor.avatarEmoji)}::text[]
      ) AS incoming(id, name, avatar_emoji)
      ORDER BY incoming.id
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        name = EXCLUDED.name,
        avatar_emoji = EXCLUDED.avatar_emoji,
        updated_at = NOW()
      WHERE actor_copies.origin_workspace_id = EXCLUDED.origin_workspace_id
        AND (
          actor_copies.name IS DISTINCT FROM EXCLUDED.name
          OR actor_copies.avatar_emoji IS DISTINCT FROM EXCLUDED.avatar_emoji
        )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows.map(mapRow)
  },

  async findOrigins(db: Querier, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map()
    const result = await db.query<{ id: string; origin_workspace_id: string }>(sql`
      SELECT id, origin_workspace_id FROM actor_copies
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids})
    `)
    return new Map(result.rows.map((row) => [row.id, row.origin_workspace_id]))
  },

  async listByWorkspace(db: Querier, workspaceId: string): Promise<ActorCopy[]> {
    const result = await db.query<ActorCopyRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM actor_copies
      WHERE workspace_id = ${workspaceId}
      ORDER BY id
    `)
    return result.rows.map(mapRow)
  },
}
