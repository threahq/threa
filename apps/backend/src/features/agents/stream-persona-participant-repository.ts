import { PoolClient } from "pg"
import { sql } from "../../db"

export const StreamPersonaParticipantRepository = {
  /**
   * Record that a persona has participated in a stream.
   * Idempotent - uses INSERT ON CONFLICT DO NOTHING.
   */
  async recordParticipation(
    client: PoolClient,
    workspaceId: string,
    streamId: string,
    personaId: string
  ): Promise<void> {
    await client.query(sql`
      INSERT INTO stream_persona_participants (workspace_id, stream_id, persona_id)
      VALUES (${workspaceId}, ${streamId}, ${personaId})
      ON CONFLICT (stream_id, persona_id) DO NOTHING
    `)
  },

  async hasParticipated(
    client: PoolClient,
    workspaceId: string,
    streamId: string,
    personaId: string
  ): Promise<boolean> {
    const result = await client.query(sql`
      SELECT 1 FROM stream_persona_participants
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND persona_id = ${personaId}
    `)
    return result.rows.length > 0
  },
}
