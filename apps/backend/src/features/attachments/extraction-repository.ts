import { sql, type Querier } from "../../db"
import { detectSearchConfig } from "../../lib/text-search-config"
import type {
  ExtractionContentType,
  ExtractionSourceType,
  PdfSizeTier,
  ChartData,
  TableData,
  DiagramData,
  TextMetadata,
  WordMetadata,
  ExcelMetadata,
} from "@threa/types"

interface AttachmentExtractionRow {
  id: string
  attachment_id: string
  workspace_id: string
  content_type: string
  summary: string
  full_text: string | null
  structured_data: unknown | null
  source_type: string
  pdf_metadata: unknown | null
  text_metadata: unknown | null
  word_metadata: unknown | null
  excel_metadata: unknown | null
  // Projected as `(summary_embedding IS NOT NULL)`, not the vector itself — see SELECT_FIELDS.
  summary_embedding: boolean
  created_at: Date
  updated_at: Date
}

export interface PdfMetadata {
  totalPages: number
  sizeTier: PdfSizeTier
  sections?: PdfSection[]
}

export interface PdfSection {
  startPage: number
  endPage: number
  title: string
}

export interface AttachmentExtraction {
  id: string
  attachmentId: string
  workspaceId: string
  contentType: ExtractionContentType
  summary: string
  fullText: string | null
  structuredData: ChartData | TableData | DiagramData | null
  sourceType: ExtractionSourceType
  pdfMetadata: PdfMetadata | null
  textMetadata: TextMetadata | null
  wordMetadata: WordMetadata | null
  excelMetadata: ExcelMetadata | null
  /**
   * Whether the summary embedding has been generated. Surfaced as a boolean so
   * callers can route around an in-flight backfill without parsing the vector
   * literal. The vector itself is never read by the application — semantic
   * search runs as a SQL distance comparison against the column directly.
   */
  hasSummaryEmbedding: boolean
  createdAt: Date
  updatedAt: Date
}

export interface InsertAttachmentExtractionParams {
  id: string
  attachmentId: string
  workspaceId: string
  contentType: ExtractionContentType
  summary: string
  fullText?: string | null
  structuredData?: ChartData | TableData | DiagramData | null
  sourceType?: ExtractionSourceType
  pdfMetadata?: PdfMetadata | null
  textMetadata?: TextMetadata | null
  wordMetadata?: WordMetadata | null
  excelMetadata?: ExcelMetadata | null
}

/** The text an extraction's `search_vector` is built from, and so the text its stemmer is detected from. */
export function extractionSearchText(params: { summary: string; fullText?: string | null }): string {
  return `${params.summary} ${params.fullText ?? ""}`
}

function mapRowToExtraction(row: AttachmentExtractionRow): AttachmentExtraction {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    workspaceId: row.workspace_id,
    contentType: row.content_type as ExtractionContentType,
    summary: row.summary,
    fullText: row.full_text,
    structuredData: row.structured_data as ChartData | TableData | DiagramData | null,
    sourceType: row.source_type as ExtractionSourceType,
    pdfMetadata: row.pdf_metadata as PdfMetadata | null,
    textMetadata: row.text_metadata as TextMetadata | null,
    wordMetadata: row.word_metadata as WordMetadata | null,
    excelMetadata: row.excel_metadata as ExcelMetadata | null,
    hasSummaryEmbedding: row.summary_embedding,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// `summary_embedding IS NOT NULL` is cheaper to ship than the vector literal,
// which can be 30KB of text per row, and the application never reads the
// embedding itself — only its presence.
const SELECT_FIELDS = `
  id, attachment_id, workspace_id,
  content_type, summary, full_text, structured_data,
  source_type, pdf_metadata, text_metadata, word_metadata, excel_metadata,
  (summary_embedding IS NOT NULL) AS summary_embedding,
  created_at, updated_at
`

export const AttachmentExtractionRepository = {
  async insert(client: Querier, params: InsertAttachmentExtractionParams): Promise<AttachmentExtraction> {
    const result = await client.query<AttachmentExtractionRow>(sql`
      INSERT INTO attachment_extractions (
        id, attachment_id, workspace_id,
        content_type, summary, full_text, search_config, structured_data,
        source_type, pdf_metadata, text_metadata, word_metadata, excel_metadata
      )
      VALUES (
        ${params.id},
        ${params.attachmentId},
        ${params.workspaceId},
        ${params.contentType},
        ${params.summary},
        ${params.fullText ?? null},
        ${detectSearchConfig(extractionSearchText(params))},
        ${params.structuredData ? JSON.stringify(params.structuredData) : null},
        ${params.sourceType ?? "image"},
        ${params.pdfMetadata ? JSON.stringify(params.pdfMetadata) : null},
        ${params.textMetadata ? JSON.stringify(params.textMetadata) : null},
        ${params.wordMetadata ? JSON.stringify(params.wordMetadata) : null},
        ${params.excelMetadata ? JSON.stringify(params.excelMetadata) : null}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToExtraction(result.rows[0])
  },

  /**
   * Copy an existing extraction to a NEW attachment id in one `INSERT ... SELECT`
   * (persona knowledge-by-reference copy-on-attach): the copied file has identical
   * content, so its `summary_embedding` carries over natively — no re-embed job.
   * `search_vector` is GENERATED and never copied; `search_config` is, since the
   * copied text is identical. Workspace-scoped on the source read (INV-8). Returns
   * `true` when a source row existed and was copied; `false` when the source has no
   * extraction yet (the caller kicks the pipeline instead).
   */
  async copyForAttachment(
    client: Querier,
    params: { id: string; sourceAttachmentId: string; attachmentId: string; workspaceId: string }
  ): Promise<boolean> {
    const result = await client.query(sql`
      INSERT INTO attachment_extractions (
        id, attachment_id, workspace_id,
        content_type, summary, full_text, search_config, structured_data,
        source_type, pdf_metadata, text_metadata, word_metadata, excel_metadata,
        summary_embedding
      )
      SELECT
        ${params.id}, ${params.attachmentId}, ${params.workspaceId},
        content_type, summary, full_text, search_config, structured_data,
        source_type, pdf_metadata, text_metadata, word_metadata, excel_metadata,
        summary_embedding
      FROM attachment_extractions
      WHERE attachment_id = ${params.sourceAttachmentId} AND workspace_id = ${params.workspaceId}
    `)
    return (result.rowCount ?? 0) > 0
  },

  async findByAttachmentId(client: Querier, attachmentId: string): Promise<AttachmentExtraction | null> {
    const result = await client.query<AttachmentExtractionRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM attachment_extractions WHERE attachment_id = ${attachmentId}`
    )
    return result.rows[0] ? mapRowToExtraction(result.rows[0]) : null
  },

  async findByAttachmentIds(client: Querier, attachmentIds: string[]): Promise<Map<string, AttachmentExtraction>> {
    if (attachmentIds.length === 0) return new Map()

    const result = await client.query<AttachmentExtractionRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM attachment_extractions WHERE attachment_id = ANY(${attachmentIds})`
    )

    const byAttachment = new Map<string, AttachmentExtraction>()
    for (const row of result.rows) {
      byAttachment.set(row.attachment_id, mapRowToExtraction(row))
    }
    return byAttachment
  },

  async findByWorkspace(
    client: Querier,
    workspaceId: string,
    options?: {
      contentType?: ExtractionContentType
      limit?: number
      offset?: number
    }
  ): Promise<AttachmentExtraction[]> {
    const limit = options?.limit ?? 100
    const offset = options?.offset ?? 0

    if (options?.contentType) {
      const result = await client.query<AttachmentExtractionRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM attachment_extractions
        WHERE workspace_id = ${workspaceId} AND content_type = ${options.contentType}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `)
      return result.rows.map(mapRowToExtraction)
    }

    const result = await client.query<AttachmentExtractionRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM attachment_extractions
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `)
    return result.rows.map(mapRowToExtraction)
  },

  async deleteByAttachmentId(client: Querier, attachmentId: string): Promise<boolean> {
    const result = await client.query(sql`
      DELETE FROM attachment_extractions WHERE attachment_id = ${attachmentId}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /** Rows whose config was set in the meantime (a re-extraction re-detects) are left alone (INV-20). */
  async fillMissingSearchConfigs(client: Querier, rows: Array<{ id: string; searchConfig: string }>): Promise<number> {
    if (rows.length === 0) return 0
    const result = await client.query(sql`
      UPDATE attachment_extractions e
      SET search_config = v.search_config
      FROM UNNEST(${rows.map((row) => row.id)}::text[], ${rows.map((row) => row.searchConfig)}::text[]) AS v(id, search_config)
      WHERE e.id = v.id AND e.search_config IS NULL
    `)
    return result.rowCount ?? 0
  },

  /**
   * Persist the summary embedding for an extraction. Idempotent — re-running
   * the embedding worker overwrites the column without further coordination.
   * Returns `true` if a row was matched (the extraction may have been deleted
   * between enqueue and execution, or the workspace check below may have
   * filtered it out).
   *
   * The `workspace_id` predicate enforces the workspace shard boundary
   * (INV-8) at the data layer so a future caller can't accidentally embed
   * across workspaces even if it skips the worker's pre-check.
   */
  async updateSummaryEmbedding(
    client: Querier,
    workspaceId: string,
    attachmentId: string,
    embedding: number[]
  ): Promise<boolean> {
    const embeddingLiteral = `[${embedding.join(",")}]`
    const result = await client.query(sql`
      UPDATE attachment_extractions
      SET summary_embedding = ${embeddingLiteral}::vector,
          updated_at = NOW()
      WHERE attachment_id = ${attachmentId}
        AND workspace_id = ${workspaceId}
    `)
    return (result.rowCount ?? 0) > 0
  },
}
