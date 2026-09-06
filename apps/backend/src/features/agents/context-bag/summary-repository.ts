import type { Querier } from "../../../db"
import { sql } from "../../../db"
import type { ContextRefKind } from "@threahq/types"
import { contextSummaryId } from "../../../lib/id"
import type { SummaryInput } from "./types"

interface ContextSummaryRow {
  id: string
  workspace_id: string
  ref_kind: string
  ref_key: string
  fingerprint: string
  inputs: unknown
  summary_text: string
  model: string
  created_at: Date
}

export interface StoredSummary {
  id: string
  workspaceId: string
  refKind: ContextRefKind
  refKey: string
  fingerprint: string
  inputs: SummaryInput[]
  summaryText: string
  model: string
  createdAt: Date
}

function mapRow(row: ContextSummaryRow): StoredSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    refKind: row.ref_kind as ContextRefKind,
    refKey: row.ref_key,
    fingerprint: row.fingerprint,
    inputs: (row.inputs ?? []) as SummaryInput[],
    summaryText: row.summary_text,
    model: row.model,
    createdAt: row.created_at,
  }
}

const SELECT_FIELDS = `id, workspace_id, ref_kind, ref_key, fingerprint, inputs, summary_text, model, created_at`

export interface UpsertSummaryParams {
  workspaceId: string
  refKind: ContextRefKind
  refKey: string
  fingerprint: string
  inputs: SummaryInput[]
  summaryText: string
  model: string
}

export const SummaryRepository = {
  /**
   * Look up a cached summary by its identity tuple. Callers must verify access
   * to the underlying ref BEFORE calling this (INV-8): a hit without access
   * must behave as a miss.
   */
  async find(
    db: Querier,
    params: { workspaceId: string; refKind: ContextRefKind; refKey: string; fingerprint: string }
  ): Promise<StoredSummary | null> {
    const result = await db.query<ContextSummaryRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM context_summaries
      WHERE workspace_id = ${params.workspaceId}
        AND ref_kind = ${params.refKind}
        AND ref_key = ${params.refKey}
        AND fingerprint = ${params.fingerprint}
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Insert a new summary. Uses ON CONFLICT DO NOTHING on the unique lookup
   * index (INV-20: race-safe). If another writer inserted first, re-fetch
   * the winning row so the caller always gets a valid summary back.
   */
  async upsert(db: Querier, params: UpsertSummaryParams): Promise<StoredSummary> {
    const id = contextSummaryId()
    const inputsJson = JSON.stringify(params.inputs)
    const result = await db.query<ContextSummaryRow>(sql`
      INSERT INTO context_summaries (
        id, workspace_id, ref_kind, ref_key, fingerprint, inputs, summary_text, model
      ) VALUES (
        ${id}, ${params.workspaceId}, ${params.refKind}, ${params.refKey},
        ${params.fingerprint}, ${inputsJson}::jsonb, ${params.summaryText}, ${params.model}
      )
      ON CONFLICT (workspace_id, ref_kind, ref_key, fingerprint) DO NOTHING
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)

    if (result.rows[0]) {
      return mapRow(result.rows[0])
    }

    // Lost the race — read the row the winning writer inserted.
    const existing = await SummaryRepository.find(db, {
      workspaceId: params.workspaceId,
      refKind: params.refKind,
      refKey: params.refKey,
      fingerprint: params.fingerprint,
    })
    if (!existing) {
      throw new Error("SummaryRepository.upsert: ON CONFLICT raced but no row could be read back")
    }
    return existing
  },
}
