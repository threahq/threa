import { sql, type Querier } from "../../../db"
import type { PdfPageClassification, ProcessingStatus } from "@threa/types"

interface PdfPageExtractionRow {
  id: string
  attachment_id: string
  workspace_id: string
  page_number: number
  classification: string
  raw_text: string | null
  ocr_text: string | null
  markdown_content: string | null
  embedded_images: unknown | null
  processing_status: string
  error_message: string | null
  created_at: Date
  updated_at: Date
}

export interface PdfPageExtraction {
  id: string
  attachmentId: string
  workspaceId: string
  pageNumber: number
  classification: PdfPageClassification
  rawText: string | null
  ocrText: string | null
  markdownContent: string | null
  embeddedImages: EmbeddedImage[] | null
  processingStatus: ProcessingStatus
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
}

export interface EmbeddedImage {
  id: string
  storagePath: string
  caption: string | null
}

export interface InsertPdfPageExtractionParams {
  id: string
  attachmentId: string
  workspaceId: string
  pageNumber: number
  classification: PdfPageClassification
  rawText?: string | null
  ocrText?: string | null
  markdownContent?: string | null
  embeddedImages?: EmbeddedImage[] | null
  processingStatus?: ProcessingStatus
  errorMessage?: string | null
}

export interface UpdatePdfPageExtractionParams {
  rawText?: string | null
  ocrText?: string | null
  markdownContent?: string | null
  embeddedImages?: EmbeddedImage[] | null
  processingStatus?: ProcessingStatus
  errorMessage?: string | null
}

function mapRowToExtraction(row: PdfPageExtractionRow): PdfPageExtraction {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    workspaceId: row.workspace_id,
    pageNumber: row.page_number,
    classification: row.classification as PdfPageClassification,
    rawText: row.raw_text,
    ocrText: row.ocr_text,
    markdownContent: row.markdown_content,
    embeddedImages: row.embedded_images as EmbeddedImage[] | null,
    processingStatus: row.processing_status as ProcessingStatus,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_FIELDS = `
  id, attachment_id, workspace_id, page_number,
  classification, raw_text, ocr_text, markdown_content,
  embedded_images, processing_status, error_message,
  created_at, updated_at
`

export const PdfPageExtractionRepository = {
  async insert(client: Querier, params: InsertPdfPageExtractionParams): Promise<PdfPageExtraction> {
    const result = await client.query<PdfPageExtractionRow>(sql`
      INSERT INTO pdf_page_extractions (
        id, attachment_id, workspace_id, page_number,
        classification, raw_text, ocr_text, markdown_content,
        embedded_images, processing_status, error_message
      )
      VALUES (
        ${params.id},
        ${params.attachmentId},
        ${params.workspaceId},
        ${params.pageNumber},
        ${params.classification},
        ${params.rawText ?? null},
        ${params.ocrText ?? null},
        ${params.markdownContent ?? null},
        ${params.embeddedImages ? JSON.stringify(params.embeddedImages) : null},
        ${params.processingStatus ?? "pending"},
        ${params.errorMessage ?? null}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToExtraction(result.rows[0])
  },

  async insertMany(client: Querier, pages: InsertPdfPageExtractionParams[]): Promise<number> {
    if (pages.length === 0) return 0

    // Per-row inserts, kept atomic by the caller's transaction.
    let count = 0
    for (const p of pages) {
      await client.query(sql`
        INSERT INTO pdf_page_extractions (
          id, attachment_id, workspace_id, page_number,
          classification, raw_text, ocr_text, markdown_content,
          embedded_images, processing_status, error_message
        )
        VALUES (
          ${p.id},
          ${p.attachmentId},
          ${p.workspaceId},
          ${p.pageNumber},
          ${p.classification},
          ${p.rawText ?? null},
          ${p.ocrText ?? null},
          ${p.markdownContent ?? null},
          ${p.embeddedImages ? JSON.stringify(p.embeddedImages) : null},
          ${p.processingStatus ?? "pending"},
          ${p.errorMessage ?? null}
        )
      `)
      count++
    }
    return count
  },

  async findById(client: Querier, id: string): Promise<PdfPageExtraction | null> {
    const result = await client.query<PdfPageExtractionRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_page_extractions WHERE id = ${id}`
    )
    return result.rows[0] ? mapRowToExtraction(result.rows[0]) : null
  },

  async findByAttachmentId(client: Querier, attachmentId: string): Promise<PdfPageExtraction[]> {
    const result = await client.query<PdfPageExtractionRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_page_extractions
      WHERE attachment_id = ${attachmentId}
      ORDER BY page_number ASC
    `)
    return result.rows.map(mapRowToExtraction)
  },

  async findByAttachmentAndPage(
    client: Querier,
    attachmentId: string,
    pageNumber: number
  ): Promise<PdfPageExtraction | null> {
    const result = await client.query<PdfPageExtractionRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_page_extractions
      WHERE attachment_id = ${attachmentId} AND page_number = ${pageNumber}
    `)
    return result.rows[0] ? mapRowToExtraction(result.rows[0]) : null
  },

  async findByAttachmentAndPageRange(
    client: Querier,
    attachmentId: string,
    startPage: number,
    endPage: number
  ): Promise<PdfPageExtraction[]> {
    const result = await client.query<PdfPageExtractionRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_page_extractions
      WHERE attachment_id = ${attachmentId}
        AND page_number >= ${startPage}
        AND page_number <= ${endPage}
      ORDER BY page_number ASC
    `)
    return result.rows.map(mapRowToExtraction)
  },

  async update(client: Querier, id: string, params: UpdatePdfPageExtractionParams): Promise<PdfPageExtraction | null> {
    // Read-modify-write the whole row to avoid building dynamic SET clauses.
    const current = await this.findById(client, id)
    if (!current) return null

    let embeddedImages = current.embeddedImages
    if (params.embeddedImages !== undefined) {
      embeddedImages = params.embeddedImages
    }

    const result = await client.query<PdfPageExtractionRow>(sql`
      UPDATE pdf_page_extractions
      SET
        raw_text = ${params.rawText !== undefined ? params.rawText : current.rawText},
        ocr_text = ${params.ocrText !== undefined ? params.ocrText : current.ocrText},
        markdown_content = ${params.markdownContent !== undefined ? params.markdownContent : current.markdownContent},
        embedded_images = ${embeddedImages ? JSON.stringify(embeddedImages) : null},
        processing_status = ${params.processingStatus !== undefined ? params.processingStatus : current.processingStatus},
        error_message = ${params.errorMessage !== undefined ? params.errorMessage : current.errorMessage},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRowToExtraction(result.rows[0]) : null
  },

  async updateProcessingStatus(
    client: Querier,
    id: string,
    status: ProcessingStatus,
    options?: { errorMessage?: string; onlyIfStatusIn?: ProcessingStatus[] }
  ): Promise<boolean> {
    if (options?.onlyIfStatusIn) {
      const result = await client.query(sql`
        UPDATE pdf_page_extractions
        SET processing_status = ${status},
            error_message = ${options.errorMessage ?? null},
            updated_at = NOW()
        WHERE id = ${id} AND processing_status = ANY(${options.onlyIfStatusIn})
      `)
      return (result.rowCount ?? 0) > 0
    }

    const result = await client.query(sql`
      UPDATE pdf_page_extractions
      SET processing_status = ${status},
          error_message = ${options?.errorMessage ?? null},
          updated_at = NOW()
      WHERE id = ${id}
    `)
    return (result.rowCount ?? 0) > 0
  },

  async deleteByAttachmentId(client: Querier, attachmentId: string): Promise<number> {
    const result = await client.query(sql`
      DELETE FROM pdf_page_extractions WHERE attachment_id = ${attachmentId}
    `)
    return result.rowCount ?? 0
  },

  async countByStatus(
    client: Querier,
    attachmentId: string
  ): Promise<{ pending: number; processing: number; completed: number; failed: number }> {
    const result = await client.query<{ status: string; count: string }>(sql`
      SELECT processing_status as status, COUNT(*)::integer as count
      FROM pdf_page_extractions
      WHERE attachment_id = ${attachmentId}
      GROUP BY processing_status
    `)

    const counts = { pending: 0, processing: 0, completed: 0, failed: 0 }
    for (const row of result.rows) {
      if (row.status in counts) {
        counts[row.status as keyof typeof counts] = Number(row.count)
      }
    }
    return counts
  },
}
