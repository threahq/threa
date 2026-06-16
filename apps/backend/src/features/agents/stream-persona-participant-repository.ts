import { PoolClient } from "pg"
import { sql } from "../../db"

interface StreamPersonaParticipantRow {
  stream_id: string
  persona_id: string
  first_participated_at: Date
}

export interface StreamPersonaParticipant {
  streamId: string
  personaId: string
  firstParticipatedAt: Date
}

function mapRowToParticipant(row: StreamPersonaParticipantRow): StreamPersonaParticipant {
  return {
    streamId: row.stream_id,
    personaId: row.persona_id,
    firstParticipatedAt: row.first_participated_at,
  }
}

export const StreamPersonaParticipantRepository = {
  /**
   * Record that a persona has participated in a stream.
   * Idempotent - uses INSERT ON CONFLICT DO NOTHING.
   */
  async recordParticipation(client: PoolClient, streamId: string, personaId: string): Promise<void> {
    await client.query(sql`
      INSERT INTO stream_persona_participants (stream_id, persona_id)
      VALUES (${streamId}, ${personaId})
      ON CONFLICT (stream_id, persona_id) DO NOTHING
    `)
  },

  async hasParticipated(client: PoolClient, streamId: string, personaId: string): Promise<boolean> {
    const result = await client.query(sql`
      SELECT 1 FROM stream_persona_participants
      WHERE stream_id = ${streamId} AND persona_id = ${personaId}
    `)
    return result.rows.length > 0
  },

  async findStreamsByPersona(client: PoolClient, personaId: string): Promise<string[]> {
    const result = await client.query<{ stream_id: string }>(sql`
      SELECT stream_id FROM stream_persona_participants
      WHERE persona_id = ${personaId}
    `)
    return result.rows.map((r) => r.stream_id)
  },

  async findPersonasByStream(client: PoolClient, streamId: string): Promise<StreamPersonaParticipant[]> {
    const result = await client.query<StreamPersonaParticipantRow>(sql`
      SELECT stream_id, persona_id, first_participated_at
      FROM stream_persona_participants
      WHERE stream_id = ${streamId}
      ORDER BY first_participated_at
    `)
    return result.rows.map(mapRowToParticipant)
  },

  /**
   * Check which streams have ALL of the specified personas as participants.
   * Returns the set of stream IDs where every persona has participated.
   */
  async filterStreamsWithAllPersonas(
    client: PoolClient,
    streamIds: string[],
    personaIds: string[]
  ): Promise<Set<string>> {
    if (streamIds.length === 0 || personaIds.length === 0) {
      return new Set(streamIds)
    }

    const result = await client.query<{ stream_id: string }>(sql`
      SELECT stream_id
      FROM stream_persona_participants
      WHERE stream_id = ANY(${streamIds})
        AND persona_id = ANY(${personaIds})
      GROUP BY stream_id
      HAVING COUNT(DISTINCT persona_id) = ${personaIds.length}
    `)

    return new Set(result.rows.map((r) => r.stream_id))
  },
}
