import { sql, type Querier } from "../../db"

interface CommandDispatchRow {
  command_id: string
  event_id: string
}

export interface CommandDispatchRecord {
  commandId: string
  eventId: string
}

export const CommandDispatchRepository = {
  async claim(
    db: Querier,
    params: {
      commandId: string
      workspaceId: string
      userId: string
      streamId: string
      clientCommandId: string
      eventId: string
    }
  ): Promise<boolean> {
    const result = await db.query<{ command_id: string }>(sql`
      INSERT INTO command_dispatches (
        command_id, workspace_id, user_id, stream_id, client_command_id, event_id
      )
      VALUES (
        ${params.commandId}, ${params.workspaceId}, ${params.userId}, ${params.streamId},
        ${params.clientCommandId}, ${params.eventId}
      )
      ON CONFLICT (workspace_id, user_id, stream_id, client_command_id) DO NOTHING
      RETURNING command_id
    `)
    return result.rowCount === 1
  },

  async findByClientId(
    db: Querier,
    params: { workspaceId: string; userId: string; streamId: string; clientCommandId: string }
  ): Promise<CommandDispatchRecord | null> {
    const result = await db.query<CommandDispatchRow>(sql`
      SELECT command_id, event_id
      FROM command_dispatches
      WHERE workspace_id = ${params.workspaceId}
        AND user_id = ${params.userId}
        AND stream_id = ${params.streamId}
        AND client_command_id = ${params.clientCommandId}
    `)
    const row = result.rows[0]
    return row ? { commandId: row.command_id, eventId: row.event_id } : null
  },
}
