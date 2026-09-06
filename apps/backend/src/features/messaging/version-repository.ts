import type { Querier } from "../../db"
import { sql } from "../../db"
import type { JSONContent } from "@threahq/types"

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

/** One `(messageId, versionNumber)` pin to load. */
export interface MessageVersionKey {
  messageId: string
  versionNumber: number
}

/** Map key for {@link MessageVersionRepository.findByMessageVersions} results. */
export function messageVersionKey(messageId: string, versionNumber: number): string {
  return `${messageId}@${versionNumber}`
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
        GREATEST(
          ${params.versionNumber},
          COALESCE((SELECT MAX(version_number) FROM message_versions WHERE message_id = ${params.messageId}), 0) + 1
        ),
        ${JSON.stringify(params.contentJson)},
        ${params.contentMarkdown},
        ${params.editedBy}
      )
      RETURNING *
    `)
    if (!result.rows[0]) throw new Error(`Failed to insert message version for ${params.messageId}`)
    return mapRow(result.rows[0])
  },

  /**
   * Load specific `(messageId, versionNumber)` snapshots in one query — the
   * read behind pinned references, which resolve a handful of distinct pins
   * across a page of messages (INV-56).
   *
   * Keyed by {@link messageVersionKey}. A pin at the message's CURRENT
   * revision has no `message_versions` row (the row is written on edit, for
   * the body being superseded), so callers read that one off `messages`.
   */
  async findByMessageVersions(db: Querier, keys: readonly MessageVersionKey[]): Promise<Map<string, MessageVersion>> {
    if (keys.length === 0) return new Map()

    const result = await db.query<MessageVersionRow>(sql`
      SELECT v.* FROM message_versions v
      JOIN unnest(${keys.map((k) => k.messageId)}::text[], ${keys.map((k) => k.versionNumber)}::int[])
        AS want(message_id, version_number)
        ON v.message_id = want.message_id AND v.version_number = want.version_number
    `)

    const map = new Map<string, MessageVersion>()
    for (const row of result.rows) {
      map.set(messageVersionKey(row.message_id, row.version_number), mapRow(row))
    }
    return map
  },

  /**
   * Every stored snapshot for a set of messages, oldest first per message —
   * the read behind the pin backfill, which has to try a legacy quote's
   * snippet against each candidate revision (INV-56: one query per chunk,
   * never one per source).
   */
  async findByMessageIds(db: Querier, messageIds: readonly string[]): Promise<Map<string, MessageVersion[]>> {
    if (messageIds.length === 0) return new Map()

    const result = await db.query<MessageVersionRow>(sql`
      SELECT * FROM message_versions
      WHERE message_id = ANY(${[...messageIds]})
      ORDER BY message_id, version_number ASC
    `)

    const map = new Map<string, MessageVersion[]>()
    for (const row of result.rows) {
      const existing = map.get(row.message_id)
      if (existing) existing.push(mapRow(row))
      else map.set(row.message_id, [mapRow(row)])
    }
    return map
  },

  async listByMessageId(db: Querier, messageId: string): Promise<MessageVersion[]> {
    const result = await db.query<MessageVersionRow>(sql`
      SELECT * FROM message_versions
      WHERE message_id = ${messageId}
      ORDER BY version_number ASC
    `)
    return result.rows.map(mapRow)
  },

  /**
   * A version row holds the content that occupied its `version_number`
   * revision, written when that revision was replaced — so the text a reader
   * saw at revision N is version N, and the live message row is the newest
   * revision, which has no version row yet.
   */
  async findByVersionNumbers(db: Querier, messageId: string, versionNumbers: number[]): Promise<MessageVersion[]> {
    if (versionNumbers.length === 0) return []
    const result = await db.query<MessageVersionRow>(sql`
      SELECT * FROM message_versions
      WHERE message_id = ${messageId} AND version_number = ANY(${versionNumbers})
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
