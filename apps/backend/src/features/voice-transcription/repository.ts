import { sql } from "../../db"
import type { Querier } from "../../db"
import type { VoiceSessionStatus } from "./config"

export interface VoiceSessionRow {
  id: string
  workspaceId: string
  userId: string
  model: string
  provider: string
  region: string
  language: string | null
  status: VoiceSessionStatus
  totalAudioMs: number
  createdAt: Date
  finishedAt: Date | null
  expiresAt: Date
}

const SELECT_FIELDS = `
  id, workspace_id, user_id, model, provider, region, language, status,
  total_audio_ms, created_at, finished_at, expires_at
`

function mapRow(row: Record<string, unknown>): VoiceSessionRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    userId: row.user_id as string,
    model: row.model as string,
    provider: row.provider as string,
    region: row.region as string,
    language: row.language as string | null,
    status: row.status as VoiceSessionStatus,
    totalAudioMs: Number(row.total_audio_ms),
    createdAt: row.created_at as Date,
    finishedAt: row.finished_at as Date | null,
    expiresAt: row.expires_at as Date,
  }
}

export const VoiceSessionRepository = {
  async insert(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      userId: string
      model: string
      provider: string
      region: string
      language: string | null
      expiresAt: Date
    }
  ): Promise<VoiceSessionRow> {
    const result = await db.query<Record<string, unknown>>(sql`
      INSERT INTO voice_sessions (id, workspace_id, user_id, model, provider, region, language, expires_at)
      VALUES (
        ${params.id}, ${params.workspaceId}, ${params.userId}, ${params.model},
        ${params.provider}, ${params.region}, ${params.language}, ${params.expiresAt}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0])
  },

  async findOwned(db: Querier, workspaceId: string, userId: string, id: string): Promise<VoiceSessionRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM voice_sessions
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Atomically transition an active session to a terminal status, recording
   * billed audio duration. Single guarded UPDATE — no select-then-update
   * (INV-20). Returns "ok" if it transitioned, else why not.
   */
  async finalizeOwned(
    db: Querier,
    params: {
      workspaceId: string
      userId: string
      id: string
      status: Extract<VoiceSessionStatus, "finished" | "aborted" | "expired">
      totalAudioMs: number
    }
  ): Promise<"ok" | "not_found" | "already_final"> {
    const result = await db.query(sql`
      UPDATE voice_sessions
      SET status = ${params.status},
          finished_at = NOW(),
          total_audio_ms = ${params.totalAudioMs}
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND user_id = ${params.userId}
        AND status = 'active'
    `)
    if ((result.rowCount ?? 0) > 0) return "ok"

    const exists = await db.query(sql`
      SELECT 1 FROM voice_sessions
      WHERE id = ${params.id} AND workspace_id = ${params.workspaceId} AND user_id = ${params.userId}
    `)
    return exists.rowCount === 0 ? "not_found" : "already_final"
  },

  /**
   * Sweep every active session past its hard `expires_at` to the terminal
   * `expired` status in one set-based UPDATE (INV-56), guarded on status so
   * concurrent finalizers can't double-transition (INV-20). Returns how many
   * rows were swept. Backed by idx_voice_sessions_expiry (status, expires_at).
   */
  async expireStale(db: Querier, now: Date): Promise<number> {
    const result = await db.query(sql`
      UPDATE voice_sessions
      SET status = 'expired', finished_at = NOW()
      WHERE status = 'active' AND expires_at <= ${now}
    `)
    return result.rowCount ?? 0
  },
}
