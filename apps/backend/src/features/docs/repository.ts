import type { AuthorType, DocSection, JSONContent } from "@threahq/types"
import { sql, type Querier } from "../../db"

interface DocHeadRow {
  workspace_id: string
  stream_id: string
  update_seq: number
  body_markdown: string
  body_json: JSONContent
  created_at: Date
  updated_at: Date
}

export interface DocHead {
  workspaceId: string
  streamId: string
  updateSeq: number
  bodyMarkdown: string
  bodyJson: JSONContent
  createdAt: Date
  updatedAt: Date
}

interface DocUpdateRow {
  seq: number
  update: Buffer
  actor_id: string
  actor_type: AuthorType
}

export interface DocUpdate {
  seq: number
  update: Uint8Array
  actorId: string
  actorType: AuthorType
}

export interface DocSnapshot {
  seq: number
  state: Uint8Array
}

interface DocSectionRow {
  block_id: string
  position: number
  kind: string
  markdown: string
  content_json: JSONContent
}

const HEAD_COLUMNS = "workspace_id, stream_id, update_seq, body_markdown, body_json, created_at, updated_at"

const SECTION_COLUMNS = "block_id, position, kind, markdown, content_json"

function mapSection(row: DocSectionRow): DocSection {
  return {
    blockId: row.block_id,
    position: row.position,
    kind: row.kind,
    markdown: row.markdown,
    contentJson: row.content_json,
  }
}

function mapHead(row: DocHeadRow): DocHead {
  return {
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    updateSeq: row.update_seq,
    bodyMarkdown: row.body_markdown,
    bodyJson: row.body_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const DocRepository = {
  async insertHead(db: Querier, params: { workspaceId: string; streamId: string }): Promise<DocHead> {
    const result = await db.query<DocHeadRow>(sql`
      INSERT INTO docs (workspace_id, stream_id)
      VALUES (${params.workspaceId}, ${params.streamId})
      RETURNING ${sql.raw(HEAD_COLUMNS)}
    `)
    return mapHead(result.rows[0]!)
  },

  async findHead(db: Querier, workspaceId: string, streamId: string): Promise<DocHead | null> {
    const result = await db.query<DocHeadRow>(sql`
      SELECT ${sql.raw(HEAD_COLUMNS)} FROM docs WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
    `)
    return result.rows[0] ? mapHead(result.rows[0]) : null
  },

  async listHeads(db: Querier, workspaceId: string, streamIds: readonly string[]): Promise<DocHead[]> {
    if (streamIds.length === 0) return []
    const result = await db.query<DocHeadRow>(sql`
      SELECT ${sql.raw(HEAD_COLUMNS)} FROM docs WHERE workspace_id = ${workspaceId} AND stream_id = ANY(${streamIds})
    `)
    return result.rows.map(mapHead)
  },

  /**
   * The per-doc write lock, taken after the stream chain's lock
   * (`resolveLockedStreamAuthorities`): seq allocation and projection happen under it.
   */
  async findHeadForUpdate(db: Querier, workspaceId: string, streamId: string): Promise<DocHead | null> {
    const result = await db.query<DocHeadRow>(sql`
      SELECT ${sql.raw(HEAD_COLUMNS)} FROM docs
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      FOR UPDATE
    `)
    return result.rows[0] ? mapHead(result.rows[0]) : null
  },

  /** Caller holds the head row lock (`findHeadForUpdate`). */
  async bumpHead(
    db: Querier,
    params: { workspaceId: string; streamId: string; seq: number; bodyMarkdown: string; bodyJson: JSONContent }
  ): Promise<void> {
    await db.query(sql`
      UPDATE docs SET
        update_seq = ${params.seq},
        body_markdown = ${params.bodyMarkdown},
        body_json = ${JSON.stringify(params.bodyJson)}::jsonb,
        updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND stream_id = ${params.streamId}
    `)
  },

  async insertUpdate(db: Querier, params: { workspaceId: string; docId: string } & DocUpdate): Promise<void> {
    await db.query(sql`
      INSERT INTO doc_updates (workspace_id, doc_id, seq, update, actor_id, actor_type)
      VALUES (
        ${params.workspaceId}, ${params.docId}, ${params.seq}, ${Buffer.from(params.update)},
        ${params.actorId}, ${params.actorType}
      )
    `)
  },

  async listUpdatesAfter(db: Querier, workspaceId: string, docId: string, afterSeq: number): Promise<DocUpdate[]> {
    const result = await db.query<DocUpdateRow>(sql`
      SELECT seq, update, actor_id, actor_type FROM doc_updates
      WHERE workspace_id = ${workspaceId} AND doc_id = ${docId} AND seq > ${afterSeq}
      ORDER BY seq
    `)
    return result.rows.map((row) => ({
      seq: row.seq,
      update: new Uint8Array(row.update),
      actorId: row.actor_id,
      actorType: row.actor_type,
    }))
  },

  async insertSnapshot(
    db: Querier,
    params: { workspaceId: string; docId: string; seq: number; state: Uint8Array }
  ): Promise<void> {
    await db.query(sql`
      INSERT INTO doc_snapshots (workspace_id, doc_id, seq, state)
      VALUES (${params.workspaceId}, ${params.docId}, ${params.seq}, ${Buffer.from(params.state)})
    `)
  },

  async findLatestSnapshot(db: Querier, workspaceId: string, docId: string): Promise<DocSnapshot | null> {
    const result = await db.query<{ seq: number; state: Buffer }>(sql`
      SELECT seq, state FROM doc_snapshots
      WHERE workspace_id = ${workspaceId} AND doc_id = ${docId}
      ORDER BY seq DESC
      LIMIT 1
    `)
    const row = result.rows[0]
    return row ? { seq: row.seq, state: new Uint8Array(row.state) } : null
  },

  /** Makes the doc's section rows exactly `sections`; rows whose content is unchanged are not rewritten. */
  async replaceSections(
    db: Querier,
    workspaceId: string,
    docId: string,
    sections: readonly DocSection[]
  ): Promise<void> {
    const blockIds = sections.map((section) => section.blockId)
    await db.query(sql`
      DELETE FROM doc_sections
      WHERE workspace_id = ${workspaceId} AND doc_id = ${docId} AND NOT (block_id = ANY(${blockIds}::text[]))
    `)
    if (sections.length === 0) return
    await db.query(sql`
      INSERT INTO doc_sections (workspace_id, doc_id, block_id, position, kind, markdown, content_json)
      SELECT ${workspaceId}, ${docId}, s.block_id, s.position, s.kind, s.markdown, s.content_json
      FROM unnest(
        ${blockIds}::text[],
        ${sections.map((section) => section.position)}::integer[],
        ${sections.map((section) => section.kind)}::text[],
        ${sections.map((section) => section.markdown)}::text[],
        ${sections.map((section) => JSON.stringify(section.contentJson))}::jsonb[]
      ) AS s(block_id, position, kind, markdown, content_json)
      ON CONFLICT (workspace_id, doc_id, block_id) DO UPDATE SET
        position = EXCLUDED.position,
        kind = EXCLUDED.kind,
        markdown = EXCLUDED.markdown,
        content_json = EXCLUDED.content_json,
        updated_at = NOW()
      WHERE (doc_sections.position, doc_sections.kind, doc_sections.markdown, doc_sections.content_json)
        IS DISTINCT FROM (EXCLUDED.position, EXCLUDED.kind, EXCLUDED.markdown, EXCLUDED.content_json)
    `)
  },

  async listSections(db: Querier, workspaceId: string, docId: string): Promise<DocSection[]> {
    const result = await db.query<DocSectionRow>(sql`
      SELECT ${sql.raw(SECTION_COLUMNS)} FROM doc_sections
      WHERE workspace_id = ${workspaceId} AND doc_id = ${docId}
      ORDER BY position
    `)
    return result.rows.map(mapSection)
  },

  /** Each doc's first section that has text, keyed by doc id; docs with none are absent. */
  async listFirstSections(db: Querier, workspaceId: string, docIds: string[]): Promise<Map<string, string>> {
    if (docIds.length === 0) return new Map()
    const result = await db.query<{ doc_id: string; markdown: string }>(sql`
      SELECT DISTINCT ON (doc_id) doc_id, markdown FROM doc_sections
      WHERE workspace_id = ${workspaceId} AND doc_id = ANY(${docIds}::text[]) AND markdown ~ '\\S'
      ORDER BY doc_id, position
    `)
    return new Map(result.rows.map((row) => [row.doc_id, row.markdown]))
  },

  async findSection(db: Querier, workspaceId: string, docId: string, blockId: string): Promise<DocSection | null> {
    const result = await db.query<DocSectionRow>(sql`
      SELECT ${sql.raw(SECTION_COLUMNS)} FROM doc_sections
      WHERE workspace_id = ${workspaceId} AND doc_id = ${docId} AND block_id = ${blockId}
    `)
    return result.rows[0] ? mapSection(result.rows[0]) : null
  },
}
