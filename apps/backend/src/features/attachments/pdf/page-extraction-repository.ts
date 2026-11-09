import { sql, type Querier } from "../../../db"
import type { PdfPageClassification, ProcessingStatus } from "@threahq/types"
import { stripNul, toJsonWithoutNul } from "../extraction-sanitization"

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
        ${stripNul(params.rawText) ?? null},
        ${stripNul(params.ocrText) ?? null},
        ${stripNul(params.markdownContent) ?? null},
        ${params.embeddedImages ? toJsonWithoutNul(params.embeddedImages) : null},
        ${params.processingStatus ?? "pending"},
        ${stripNul(params.errorMessage) ?? null}
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
          ${stripNul(p.rawText) ?? null},
          ${stripNul(p.ocrText) ?? null},
          ${stripNul(p.markdownContent) ?? null},
          ${p.embeddedImages ? toJsonWithoutNul(p.embeddedImages) : null},
          ${p.processingStatus ?? "pending"},
          ${stripNul(p.errorMessage) ?? null}
        )
      `)
      count++
    }
    return count
  },

  async findById(client: Querier, workspaceId: string, id: string): Promise<PdfPageExtraction | null> {
    const result = await client.query<PdfPageExtractionRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_page_extractions WHERE workspace_id = ${workspaceId} AND id = ${id}`
    )
    return result.rows[0] ? mapRowToExtraction(result.rows[0]) : null
  },

  async findByAttachmentId(client: Querier, workspaceId: string, attachmentId: string): Promise<PdfPageExtraction[]> {
    const result = await client.query<PdfPageExtractionRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_page_extractions
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId}
      ORDER BY page_number ASC
    `)
    return result.rows.map(mapRowToExtraction)
  },

  async findByAttachmentAndPage(
    client: Querier,
    workspaceId: string,
    attachmentId: string,
    pageNumber: number
  ): Promise<PdfPageExtraction | null> {
    const result = await client.query<PdfPageExtractionRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_page_extractions
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId} AND page_number = ${pageNumber}
    `)
    return result.rows[0] ? mapRowToExtraction(result.rows[0]) : null
  },

  async findByAttachmentAndPageRange(
    client: Querier,
    workspaceId: string,
    attachmentId: string,
    startPage: number,
    endPage: number
  ): Promise<PdfPageExtraction[]> {
    const result = await client.query<PdfPageExtractionRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_page_extractions
      WHERE workspace_id = ${workspaceId}
        AND attachment_id = ${attachmentId}
        AND page_number >= ${startPage}
        AND page_number <= ${endPage}
      ORDER BY page_number ASC
    `)
    return result.rows.map(mapRowToExtraction)
  },

  async update(
    client: Querier,
    workspaceId: string,
    id: string,
    params: UpdatePdfPageExtractionParams
  ): Promise<PdfPageExtraction | null> {
    // Read-modify-write the whole row to avoid building dynamic SET clauses.
    const current = await this.findById(client, workspaceId, id)
    if (!current) return null

    let embeddedImages = current.embeddedImages
    if (params.embeddedImages !== undefined) {
      embeddedImages = params.embeddedImages
    }

    const result = await client.query<PdfPageExtractionRow>(sql`
      UPDATE pdf_page_extractions
      SET
        raw_text = ${stripNul(params.rawText !== undefined ? params.rawText : current.rawText)},
        ocr_text = ${stripNul(params.ocrText !== undefined ? params.ocrText : current.ocrText)},
        markdown_content = ${stripNul(params.markdownContent !== undefined ? params.markdownContent : current.markdownContent)},
        embedded_images = ${embeddedImages ? toJsonWithoutNul(embeddedImages) : null},
        processing_status = ${params.processingStatus !== undefined ? params.processingStatus : current.processingStatus},
        error_message = ${stripNul(params.errorMessage !== undefined ? params.errorMessage : current.errorMessage)},
        updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${id}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRowToExtraction(result.rows[0]) : null
  },

  async updateProcessingStatus(
    client: Querier,
    workspaceId: string,
    id: string,
    status: ProcessingStatus,
    options?: { errorMessage?: string; onlyIfStatusIn?: ProcessingStatus[] }
  ): Promise<boolean> {
    if (options?.onlyIfStatusIn) {
      const result = await client.query(sql`
        UPDATE pdf_page_extractions
        SET processing_status = ${status},
            error_message = ${stripNul(options.errorMessage) ?? null},
            updated_at = NOW()
        WHERE workspace_id = ${workspaceId} AND id = ${id} AND processing_status = ANY(${options.onlyIfStatusIn})
      `)
      return (result.rowCount ?? 0) > 0
    }

    const result = await client.query(sql`
      UPDATE pdf_page_extractions
      SET processing_status = ${status},
          error_message = ${stripNul(options?.errorMessage) ?? null},
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return (result.rowCount ?? 0) > 0
  },
}
