import type { ToolPrivacyPolicy } from "@threa/types"
import type { Querier } from "../../db"
import { sql } from "../../db"

interface E2eStreamRow {
  stream_id: string
  workspace_id: string
  enabled_at: Date
  owner_user_id: string
  owner_user_key_id: string
  current_key_generation: number
  allowed_tool_categories: string[] | null
}

export interface E2eStream {
  streamId: string
  workspaceId: string
  enabledAt: Date
  ownerUserId: string
  ownerUserKeyId: string
  /** SSK generation new messages currently seal under (0 for owner-only). */
  currentKeyGeneration: number
  /**
   * Tool-privacy policy: the tool categories the enclave agent may use in this
   * stream. `null` = no restriction (default). Carried into the enclave session
   * assignment and enforced there (the server never builds the tools itself).
   */
  allowedToolCategories: ToolPrivacyPolicy
}

export interface MarkStreamE2eParams {
  streamId: string
  workspaceId: string
  ownerUserId: string
  ownerUserKeyId: string
  /**
   * SSK generation the stream starts at. Defaults to 0 (a fresh owner-only
   * stream). A thread that inherits its root's key passes the root's current
   * generation so new thread messages seal under the same generation the
   * copied wraps cover.
   */
  currentKeyGeneration?: number
}

const COLUMNS =
  "stream_id, workspace_id, enabled_at, owner_user_id, owner_user_key_id, current_key_generation, allowed_tool_categories"

function mapRow(row: E2eStreamRow): E2eStream {
  return {
    streamId: row.stream_id,
    workspaceId: row.workspace_id,
    enabledAt: row.enabled_at,
    ownerUserId: row.owner_user_id,
    ownerUserKeyId: row.owner_user_key_id,
    currentKeyGeneration: row.current_key_generation,
    allowedToolCategories: (row.allowed_tool_categories as ToolPrivacyPolicy) ?? null,
  }
}

export const E2eStreamsRepository = {
  async isE2eStream(db: Querier, workspaceId: string, streamId: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM e2e_streams
        WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      ) AS exists
    `)
    return result.rows[0]?.exists ?? false
  },

  /**
   * Return the subset of `streamIds` that are E2E in this workspace.
   * Used by the search service to partition a user's accessible streams
   * into plaintext (server-searchable) vs E2E (skip + count for the
   * "X encrypted streams excluded" indicator).
   */
  async filterE2eStreamIds(db: Querier, workspaceId: string, streamIds: string[]): Promise<string[]> {
    if (streamIds.length === 0) return []
    const result = await db.query<{ stream_id: string }>(sql`
      SELECT stream_id
      FROM e2e_streams
      WHERE workspace_id = ${workspaceId} AND stream_id = ANY(${streamIds})
    `)
    return result.rows.map((row) => row.stream_id)
  },

  /**
   * Store (or clear) the sealed display name for an E2E stream. The plaintext
   * `streams.display_name` is updated separately on the same rename; this is the
   * authoritative name an unlocked client prefers. The server holds opaque bytes
   * + framing it cannot read. Passing `null` clears both columns — used when a
   * rename can't produce a fresh seal (locked session), so a stale sealed name
   * can't outrank the new plaintext one after the next unlock.
   *
   * Returns whether a row was updated (false for a plaintext stream id — the
   * WHERE matches nothing). `Buffer.from(_, "base64")` is permissive, so we
   * round-trip-check the ciphertext and reject anything that isn't canonical
   * base64 rather than silently persisting a corrupt blob.
   */
  async updateSealedName(
    db: Querier,
    workspaceId: string,
    streamId: string,
    sealed: { ciphertext: string; envelope: unknown } | null
  ): Promise<boolean> {
    if (sealed && Buffer.from(sealed.ciphertext, "base64").toString("base64") !== sealed.ciphertext) {
      throw new Error("updateSealedName: ciphertext is not canonical base64")
    }
    const result = await db.query(sql`
      UPDATE e2e_streams
      SET name_ciphertext = ${sealed ? Buffer.from(sealed.ciphertext, "base64") : null},
          name_envelope = ${sealed ? JSON.stringify(sealed.envelope) : null}
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
    `)
    return (result.rowCount ?? 0) > 0
  },

  async getByStreamId(db: Querier, workspaceId: string, streamId: string): Promise<E2eStream | null> {
    const result = await db.query<E2eStreamRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM e2e_streams
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Roll the stream's SSK generation forward to `toGeneration`. Race-safe
   * (INV-20): the `WHERE current_key_generation = toGeneration - 1` guard means
   * exactly one of two concurrent rolls wins — the loser sees `null` and must
   * not have stored its wrap batch (callers bump inside the same transaction as
   * the wrap insert, so a lost bump rolls back its orphan wraps). Never a blind
   * `+ 1`: the caller asserts the generation it wrapped under.
   */
  async bumpKeyGeneration(
    db: Querier,
    params: { workspaceId: string; streamId: string; toGeneration: number }
  ): Promise<E2eStream | null> {
    const result = await db.query<E2eStreamRow>(sql`
      UPDATE e2e_streams
      SET current_key_generation = ${params.toGeneration}
      WHERE workspace_id = ${params.workspaceId}
        AND stream_id = ${params.streamId}
        AND current_key_generation = ${params.toGeneration - 1}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async markStreamE2e(db: Querier, params: MarkStreamE2eParams): Promise<E2eStream> {
    const result = await db.query<E2eStreamRow>(sql`
      INSERT INTO e2e_streams (
        stream_id, workspace_id, owner_user_id, owner_user_key_id, current_key_generation
      )
      VALUES (
        ${params.streamId},
        ${params.workspaceId},
        ${params.ownerUserId},
        ${params.ownerUserKeyId},
        ${params.currentKeyGeneration ?? 0}
      )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return mapRow(result.rows[0]!)
  },
}
