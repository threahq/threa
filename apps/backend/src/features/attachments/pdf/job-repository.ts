import { sql, type Querier } from "../../../db"
import type { PdfJobStatus } from "@threahq/types"

interface PdfProcessingJobRow {
  id: string
  attachment_id: string
  workspace_id: string
  total_pages: number
  pages_completed: number
  pages_failed: number
  status: string
  error_message: string | null
  started_at: Date
  completed_at: Date | null
  created_at: Date
}

export interface PdfProcessingJob {
  id: string
  attachmentId: string
  workspaceId: string
  totalPages: number
  pagesCompleted: number
  pagesFailed: number
  status: PdfJobStatus
  errorMessage: string | null
  startedAt: Date
  completedAt: Date | null
  createdAt: Date
}

export interface InsertPdfProcessingJobParams {
  id: string
  attachmentId: string
  workspaceId: string
  totalPages: number
  status?: PdfJobStatus
}

function mapRowToJob(row: PdfProcessingJobRow): PdfProcessingJob {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    workspaceId: row.workspace_id,
    totalPages: row.total_pages,
    pagesCompleted: row.pages_completed,
    pagesFailed: row.pages_failed,
    status: row.status as PdfJobStatus,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  }
}

const SELECT_FIELDS = `
  id, attachment_id, workspace_id,
  total_pages, pages_completed, pages_failed,
  status, error_message,
  started_at, completed_at, created_at
`

export const PdfProcessingJobRepository = {
  async insert(client: Querier, params: InsertPdfProcessingJobParams): Promise<PdfProcessingJob> {
    const result = await client.query<PdfProcessingJobRow>(sql`
      INSERT INTO pdf_processing_jobs (
        id, attachment_id, workspace_id, total_pages, status
      )
      VALUES (
        ${params.id},
        ${params.attachmentId},
        ${params.workspaceId},
        ${params.totalPages},
        ${params.status ?? "preparing"}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToJob(result.rows[0])
  },

  async findById(client: Querier, id: string): Promise<PdfProcessingJob | null> {
    const result = await client.query<PdfProcessingJobRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_processing_jobs WHERE id = ${id}`
    )
    return result.rows[0] ? mapRowToJob(result.rows[0]) : null
  },

  async findByAttachmentId(client: Querier, attachmentId: string): Promise<PdfProcessingJob | null> {
    const result = await client.query<PdfProcessingJobRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM pdf_processing_jobs WHERE attachment_id = ${attachmentId}`
    )
    return result.rows[0] ? mapRowToJob(result.rows[0]) : null
  },

  async updateStatus(
    client: Querier,
    id: string,
    status: PdfJobStatus,
    options?: { errorMessage?: string; onlyIfStatus?: PdfJobStatus }
  ): Promise<boolean> {
    const completedAt = status === "completed" || status === "failed" ? "NOW()" : "NULL"

    if (options?.onlyIfStatus) {
      const result = await client.query(sql`
        UPDATE pdf_processing_jobs
        SET status = ${status},
            error_message = ${options.errorMessage ?? null},
            completed_at = ${sql.raw(completedAt)}
        WHERE id = ${id} AND status = ${options.onlyIfStatus}
      `)
      return (result.rowCount ?? 0) > 0
    }

    const result = await client.query(sql`
      UPDATE pdf_processing_jobs
      SET status = ${status},
          error_message = ${options?.errorMessage ?? null},
          completed_at = ${sql.raw(completedAt)}
      WHERE id = ${id}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Atomically increment pages_completed and return the updated job for
   * fan-in coordination after each page completes.
   */
  async incrementPagesCompleted(client: Querier, id: string): Promise<PdfProcessingJob | null> {
    const result = await client.query<PdfProcessingJobRow>(sql`
      UPDATE pdf_processing_jobs
      SET pages_completed = pages_completed + 1
      WHERE id = ${id}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRowToJob(result.rows[0]) : null
  },

  /** Atomically increment pages_failed and return the updated job. */
  async incrementPagesFailed(client: Querier, id: string): Promise<PdfProcessingJob | null> {
    const result = await client.query<PdfProcessingJobRow>(sql`
      UPDATE pdf_processing_jobs
      SET pages_failed = pages_failed + 1
      WHERE id = ${id}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRowToJob(result.rows[0]) : null
  },

  async isAllPagesProcessed(client: Querier, id: string): Promise<boolean> {
    const result = await client.query<{ all_done: boolean }>(sql`
      SELECT (pages_completed + pages_failed >= total_pages) as all_done
      FROM pdf_processing_jobs
      WHERE id = ${id}
    `)
    return result.rows[0]?.all_done ?? false
  },

  async delete(client: Querier, id: string): Promise<boolean> {
    const result = await client.query(sql`
      DELETE FROM pdf_processing_jobs WHERE id = ${id}
    `)
    return (result.rowCount ?? 0) > 0
  },

  async deleteByAttachmentId(client: Querier, attachmentId: string): Promise<boolean> {
    const result = await client.query(sql`
      DELETE FROM pdf_processing_jobs WHERE attachment_id = ${attachmentId}
    `)
    return (result.rowCount ?? 0) > 0
  },
}
