import type { Querier } from "../../db"
import { sql } from "../../db"
import type { JSONContent } from "@threa/types"

interface MessageVersionRow {
  id: string
  message_id: string
  version_number: number
  content_json: JSONContent
  content_markdown: string
  edited_by: string
  created_at: Date
}

export interface MessageVersion {
  id: string
  messageId: string
  versionNumber: number
  contentJson: JSONContent
  contentMarkdown: string
  editedBy: string
  createdAt: Date
}

interface InsertParams {
  id: string
  messageId: string
  /** The revision this snapshot IS — the message's pre-edit `revision`. */
  versionNumber: number
  contentJson: JSONContent
  contentMarkdown: string
  editedBy: string
}

function mapRow(row: MessageVersionRow): MessageVersion {
  return {
    id: row.id,
    messageId: row.message_id,
    versionNumber: row.version_number,
    contentJson: row.content_json,
    contentMarkdown: row.content_markdown,
    editedBy: row.edited_by,
    createdAt: row.created_at,
  }
}

export const MessageVersionRepository = {
  async insert(db: Querier, params: InsertParams): Promise<MessageVersion> {
    const result = await db.query<MessageVersionRow>(sql`
      INSERT INTO message_versions (id, message_id, version_number, content_json, content_markdown, edited_by)
      VALUES (
        ${params.id},
        ${params.messageId},
        ${params.versionNumber},
        ${JSON.stringify(params.contentJson)},
        ${params.contentMarkdown},
        ${params.editedBy}
      )
      RETURNING *
    `)
    if (!result.rows[0]) throw new Error(`Failed to insert message version for ${params.messageId}`)
    return mapRow(result.rows[0])
  },

  async listByMessageId(db: Querier, messageId: string): Promise<MessageVersion[]> {
    const result = await db.query<MessageVersionRow>(sql`
      SELECT * FROM message_versions
      WHERE message_id = ${messageId}
      ORDER BY version_number ASC
    `)
    return result.rows.map(mapRow)
  },

  async findLatestByMessageId(db: Querier, messageId: string): Promise<MessageVersion | null> {
    const result = await db.query<MessageVersionRow>(sql`
      SELECT * FROM message_versions
      WHERE message_id = ${messageId}
      ORDER BY version_number DESC
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Returns the current revision number for a message.
   *
   * Revision semantics:
   * - Initial message content is revision 1
   * - Each edit increments revision by 1
   */
  async getCurrentRevision(db: Querier, messageId: string): Promise<number | null> {
    const result = await db.query<{ revision: number }>(sql`
      SELECT revision FROM messages WHERE id = ${messageId}
    `)

    return result.rows[0]?.revision ?? null
  },
}
