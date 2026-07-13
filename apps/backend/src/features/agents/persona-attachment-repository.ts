import { sql, type Querier } from "../../db"
import { ProcessingStatuses, type ProcessingStatus } from "@threa/types"

/**
 * A persona file whose extraction pipeline gave up: no extraction landed and the
 * attachment reached a terminal state (failed scan/extraction, or an unsupported
 * type skipped). The single predicate behind BOTH the config wire status
 * (`failed`) and the prompt's failure note, so the editor label and the prompt
 * body can never disagree about which files are unrecoverable.
 */
export function personaAttachmentExtractionFailed(item: {
  hasExtraction: boolean
  processingStatus: ProcessingStatus
}): boolean {
  return (
    !item.hasExtraction &&
    (item.processingStatus === ProcessingStatuses.FAILED || item.processingStatus === ProcessingStatuses.SKIPPED)
  )
}

interface PersonaAttachmentBindingRow {
  attachment_id: string
  workspace_id: string
  persona_id: string
  position: number
  created_by: string
  created_at: Date
}

export interface PersonaAttachmentBinding {
  attachmentId: string
  workspaceId: string
  personaId: string
  position: number
  createdBy: string
  createdAt: Date
}

function mapBinding(row: PersonaAttachmentBindingRow): PersonaAttachmentBinding {
  return {
    attachmentId: row.attachment_id,
    workspaceId: row.workspace_id,
    personaId: row.persona_id,
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

interface PersonaAttachmentListRow {
  attachment_id: string
  filename: string
  mime_type: string
  size_bytes: string
  position: number
  created_at: Date
  processing_status: string
  has_extraction: boolean
  full_text_chars: number | null
  summary_chars: number | null
}

/**
 * One bound attachment joined to its file metadata and extraction readiness, in
 * a single round trip (INV-56). `processingStatus` is the underlying
 * attachment's own pipeline state; `hasExtraction` reports whether the extraction
 * row has landed (so the service can derive the structured `ready`/`processing`/
 * `failed` wire status). `fullTextChars`/`summaryChars` are the extracted content
 * LENGTHS only (never the text — that must not ride the config wire): the config
 * fold feeds them to the same budget planner the prompt uses so each row's
 * `contextMode` is derived by identical logic (INV-29/43).
 */
export interface PersonaAttachmentListItem {
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  position: number
  createdAt: Date
  processingStatus: ProcessingStatus
  hasExtraction: boolean
  fullTextChars: number | null
  summaryChars: number | null
}

function mapListRow(row: PersonaAttachmentListRow): PersonaAttachmentListItem {
  return {
    attachmentId: row.attachment_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    position: row.position,
    createdAt: row.created_at,
    processingStatus: row.processing_status as ProcessingStatus,
    hasExtraction: row.has_extraction,
    fullTextChars: row.full_text_chars,
    summaryChars: row.summary_chars,
  }
}

interface PersonaAttachmentContentRow {
  attachment_id: string
  filename: string
  position: number
  full_text: string | null
  summary: string | null
  processing_status: string
  has_extraction: boolean
}

/**
 * A bound attachment with its extraction CONTENT (full text + summary), for the
 * dispatch-time `## Knowledge` prompt block. Distinct from
 * {@link PersonaAttachmentListItem}, which the config payload uses and which
 * carries only extraction PRESENCE — this shape drags the extracted text and so
 * is read only on the prompt path, never over the wire (decision 6/7).
 */
export interface PersonaAttachmentContentItem {
  attachmentId: string
  filename: string
  position: number
  fullText: string | null
  summary: string | null
  processingStatus: ProcessingStatus
  hasExtraction: boolean
}

function mapContentRow(row: PersonaAttachmentContentRow): PersonaAttachmentContentItem {
  return {
    attachmentId: row.attachment_id,
    filename: row.filename,
    position: row.position,
    fullText: row.full_text,
    // The extraction row stores '' for a not-yet-summarized file; normalize the
    // empty string to null so the block's "has a summary" test is a plain
    // null-check.
    summary: row.summary && row.summary.length > 0 ? row.summary : null,
    processingStatus: row.processing_status as ProcessingStatus,
    hasExtraction: row.has_extraction,
  }
}

export const PersonaAttachmentRepository = {
  /**
   * Bind an attachment to a persona at the next position, but only while the
   * persona is below its attachment cap. Mirrors the follow-up cap pattern
   * (INV-20): a transaction-scoped advisory lock keyed on (workspace, persona)
   * serializes concurrent adds so the `count(*) < cap` guard and the
   * `MAX(position)+1` are computed against an exact, stable snapshot rather than
   * a lost-update race. `db` MUST be a transaction client — the advisory lock
   * releases on commit/rollback, so a bare pool would drop it immediately and
   * defeat the serialization.
   *
   * Returns the inserted binding, or `null` when the cap is already met (no row
   * written — the caller cleans up the just-created attachment).
   */
  async insertBinding(
    db: Querier,
    params: { attachmentId: string; workspaceId: string; personaId: string; createdBy: string; maxCount: number }
  ): Promise<PersonaAttachmentBinding | null> {
    await db.query(sql`SELECT pg_advisory_xact_lock(hashtext(${params.workspaceId}), hashtext(${params.personaId}))`)
    const result = await db.query<PersonaAttachmentBindingRow>(sql`
      INSERT INTO persona_attachments (attachment_id, workspace_id, persona_id, position, created_by)
      SELECT
        ${params.attachmentId},
        ${params.workspaceId},
        ${params.personaId},
        (
          SELECT COALESCE(MAX(position), -1) + 1 FROM persona_attachments
          WHERE workspace_id = ${params.workspaceId} AND persona_id = ${params.personaId}
        ),
        ${params.createdBy}
      WHERE (
        SELECT count(*) FROM persona_attachments
        WHERE workspace_id = ${params.workspaceId} AND persona_id = ${params.personaId}
      ) < ${params.maxCount}
      RETURNING attachment_id, workspace_id, persona_id, position, created_by, created_at
    `)
    return result.rows[0] ? mapBinding(result.rows[0]) : null
  },

  /**
   * A persona's bound attachments in position order, each joined to its file
   * metadata and extraction status in one query (INV-56). Workspace-scoped on
   * the binding and the attachment row (INV-8).
   */
  async listForPersona(db: Querier, workspaceId: string, personaId: string): Promise<PersonaAttachmentListItem[]> {
    const result = await db.query<PersonaAttachmentListRow>(sql`
      SELECT
        pa.attachment_id,
        a.filename,
        a.mime_type,
        a.size_bytes,
        pa.position,
        pa.created_at,
        a.processing_status,
        (e.attachment_id IS NOT NULL) AS has_extraction,
        LENGTH(e.full_text) AS full_text_chars,
        LENGTH(e.summary) AS summary_chars
      FROM persona_attachments pa
      JOIN attachments a ON a.id = pa.attachment_id AND a.workspace_id = pa.workspace_id
      LEFT JOIN attachment_extractions e ON e.attachment_id = pa.attachment_id
      WHERE pa.workspace_id = ${workspaceId} AND pa.persona_id = ${personaId}
      ORDER BY pa.position ASC
    `)
    return result.rows.map(mapListRow)
  },

  /**
   * A persona's bound attachments in position order with their extraction
   * content (full text + summary) for the dispatch-time `## Knowledge` block, in
   * one joined query (INV-56). Same workspace + position scoping as
   * {@link listForPersona}; the extra columns are the extracted text, so this is
   * the prompt-path read only — the config payload uses the lean
   * {@link listForPersona} so `full_text` never rides the wire (decision 6/7).
   */
  async listForPersonaWithContent(
    db: Querier,
    workspaceId: string,
    personaId: string
  ): Promise<PersonaAttachmentContentItem[]> {
    const result = await db.query<PersonaAttachmentContentRow>(sql`
      SELECT
        pa.attachment_id,
        a.filename,
        pa.position,
        e.full_text,
        e.summary,
        a.processing_status,
        (e.attachment_id IS NOT NULL) AS has_extraction
      FROM persona_attachments pa
      JOIN attachments a ON a.id = pa.attachment_id AND a.workspace_id = pa.workspace_id
      LEFT JOIN attachment_extractions e ON e.attachment_id = pa.attachment_id
      WHERE pa.workspace_id = ${workspaceId} AND pa.persona_id = ${personaId}
      ORDER BY pa.position ASC
    `)
    return result.rows.map(mapContentRow)
  },

  /**
   * Delete the binding, returning true when a row was removed. Workspace- and
   * persona-scoped so a foreign or cross-workspace id can never delete another
   * persona's binding (INV-8). The attachment row + S3 object are deleted
   * separately by the caller.
   */
  async deleteBinding(db: Querier, workspaceId: string, personaId: string, attachmentId: string): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM persona_attachments
      WHERE workspace_id = ${workspaceId} AND persona_id = ${personaId} AND attachment_id = ${attachmentId}
    `)
    return (result.rowCount ?? 0) > 0
  },
}
