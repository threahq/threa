import type { Querier } from "../../db"
import { sql } from "../../db"
import { streamE2eKeyWrapId } from "../../lib/id"
import { E2eKeyWrapRecipientKinds, StreamTypes, type E2eKeyWrapRecipientKind } from "@threahq/types"

interface StreamE2eKeyWrapRow {
  key_generation: number
  recipient_key_id: string
  recipient_kind: E2eKeyWrapRecipientKind
  wrap_enc_b64: string
  wrap_ct_b64: string
}

/**
 * A stored HPKE wrap of a stream's SSK to one recipient. Wrap bytes cross this
 * boundary as base64 (matching the API wire shape): the BYTEA columns are
 * `decode`d on write and `encode`d on read inside SQL, so neither the handler
 * nor the repo juggles `Buffer`s.
 */
export interface StreamE2eKeyWrap {
  keyGeneration: number
  recipientKeyId: string
  recipientKind: E2eKeyWrapRecipientKind
  /** Base64 HPKE encapsulation. */
  wrapEnc: string
  /** Base64 HPKE-wrapped SSK. */
  wrapCt: string
}

export interface InsertKeyWrapParams {
  workspaceId: string
  streamId: string
  keyGeneration: number
  recipientKeyId: string
  recipientKind: E2eKeyWrapRecipientKind
  /** Base64 HPKE encapsulation. */
  wrapEnc: string
  /** Base64 HPKE-wrapped SSK. */
  wrapCt: string
}

function mapRow(row: StreamE2eKeyWrapRow): StreamE2eKeyWrap {
  return {
    keyGeneration: row.key_generation,
    recipientKeyId: row.recipient_key_id,
    recipientKind: row.recipient_kind,
    wrapEnc: row.wrap_enc_b64,
    wrapCt: row.wrap_ct_b64,
  }
}

export const StreamE2eKeyWrapsRepository = {
  /**
   * Store one or more SSK wraps. Race-safe (INV-20) and set-based (INV-56):
   * a single multi-row INSERT with `ON CONFLICT (slot) DO NOTHING`, so a
   * concurrent owner-create and enclave-invite can't duplicate or clobber a
   * slot. A wrap is immutable once written — re-wrapping a recipient means a
   * new `keyGeneration`, never an in-place update of an existing slot. Wrap
   * bytes arrive base64 and are `decode`d to BYTEA in SQL.
   */
  async insertMany(db: Querier, wraps: InsertKeyWrapParams[]): Promise<void> {
    if (wraps.length === 0) return
    const ids = wraps.map(() => streamE2eKeyWrapId())
    await db.query(sql`
      INSERT INTO stream_e2e_key_wraps (
        id, workspace_id, stream_id, key_generation,
        recipient_key_id, recipient_kind, wrap_enc, wrap_ct
      )
      SELECT id, workspace_id, stream_id, key_generation,
             recipient_key_id, recipient_kind,
             decode(wrap_enc_b64, 'base64'), decode(wrap_ct_b64, 'base64')
      FROM UNNEST(
        ${ids}::text[],
        ${wraps.map((w) => w.workspaceId)}::text[],
        ${wraps.map((w) => w.streamId)}::text[],
        ${wraps.map((w) => w.keyGeneration)}::int[],
        ${wraps.map((w) => w.recipientKeyId)}::text[],
        ${wraps.map((w) => w.recipientKind)}::text[],
        ${wraps.map((w) => w.wrapEnc)}::text[],
        ${wraps.map((w) => w.wrapCt)}::text[]
      ) AS t(id, workspace_id, stream_id, key_generation,
             recipient_key_id, recipient_kind, wrap_enc_b64, wrap_ct_b64)
      ON CONFLICT (workspace_id, stream_id, key_generation, recipient_key_id) DO NOTHING
    `)
  },

  /**
   * All wraps for a stream, across recipients and generations. Wrap bytes are
   * HPKE ciphertext (decryptable only by the matching private key), so it is
   * safe to return the full set to any stream member; the caller selects its
   * own `recipientKeyId` + the message's `keyGeneration`.
   */
  async listForStream(db: Querier, workspaceId: string, streamId: string): Promise<StreamE2eKeyWrap[]> {
    const result = await db.query<StreamE2eKeyWrapRow>(sql`
      SELECT key_generation, recipient_key_id, recipient_kind,
             encode(wrap_enc, 'base64') AS wrap_enc_b64,
             encode(wrap_ct, 'base64') AS wrap_ct_b64
      FROM stream_e2e_key_wraps
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      ORDER BY key_generation, recipient_kind
    `)
    return result.rows.map(mapRow)
  },

  /**
   * The revive path gates an older-generation re-wrap on the generations the
   * (singleton) enclave actor provably held, so the `recipient_kind` filter is
   * pushed into SQL rather than fetching the full wrap set and filtering in JS.
   */
  async listGenerationsForRecipientKind(
    db: Querier,
    workspaceId: string,
    streamId: string,
    recipientKind: E2eKeyWrapRecipientKind
  ): Promise<number[]> {
    const result = await db.query<{ key_generation: number }>(sql`
      SELECT DISTINCT key_generation
      FROM stream_e2e_key_wraps
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
        AND recipient_kind = ${recipientKind}
      ORDER BY key_generation
    `)
    return result.rows.map((r) => r.key_generation)
  },

  /**
   * The sealed scratchpads a bot is an actor on that one of `keyIds` could
   * serve but no wrap addresses at the current generation — the owner has to
   * re-wrap before any turn there is claimable. Asked when a runtime registers
   * a key it has never held, so a fresh key (an install restart, or the first
   * key minted for a stream-scoped runtime) nudges the owner instead of
   * silently parking every turn.
   *
   * Roots only, and unarchived, matching `listSealedRootsForBot`: a thread
   * copies its root's actor rows but carries no wraps of its own, so a nudge
   * naming one would address nothing. One row per stream — the owner's heal is
   * per stream, not per key, and re-wraps every missing recipient it finds.
   */
  async listRootsMissingBotWrap(
    db: Querier,
    params: { workspaceId: string; botId: string; keyIds: string[] }
  ): Promise<{ rootStreamId: string; ownerUserId: string }[]> {
    const result = await db.query<{ stream_id: string; owner_user_id: string }>(sql`
      SELECT DISTINCT e.stream_id, e.owner_user_id
      FROM e2e_stream_actors a
      JOIN e2e_streams e ON e.workspace_id = a.workspace_id AND e.stream_id = a.stream_id
      JOIN streams s ON s.id = a.stream_id AND s.workspace_id = a.workspace_id
      JOIN runtime_e2e_keys k ON k.workspace_id = a.workspace_id AND k.key_id = ANY(${params.keyIds}::text[])
      WHERE a.workspace_id = ${params.workspaceId}
        AND a.kind = 'bot'
        AND a.actor_id = ${params.botId}
        AND s.type = ${StreamTypes.SCRATCHPAD}
        AND s.archived_at IS NULL
        AND (k.stream_id IS NULL OR k.stream_id = a.stream_id)
        AND NOT EXISTS (
          SELECT 1 FROM stream_e2e_key_wraps w
          WHERE w.workspace_id = a.workspace_id
            AND w.stream_id = a.stream_id
            AND w.recipient_kind = ${E2eKeyWrapRecipientKinds.BOT}
            AND w.recipient_key_id = k.key_id
            AND w.key_generation = e.current_key_generation
        )
      ORDER BY e.stream_id
    `)
    return result.rows.map((row) => ({ rootStreamId: row.stream_id, ownerUserId: row.owner_user_id }))
  },

  /**
   * Drop the wraps a just-revoked bot could still open, at every generation.
   * The roll that follows a revoke only closes the future; without this, a bot
   * that never came online during its grant could still fetch the whole
   * history's wraps afterwards.
   *
   * Only keys no *remaining* actor on the stream holds are dropped. A host key
   * shared by several agents is one key id: deleting its wrap because one of
   * them was revoked would take the others' access with it. Called after the
   * actor row is gone, so "remaining" is already the post-revoke set. Roots
   * only — a thread carries no wraps of its own.
   */
  async deleteWrapsExclusiveToBot(
    db: Querier,
    params: { workspaceId: string; streamId: string; botId: string }
  ): Promise<number> {
    const result = await db.query(sql`
      DELETE FROM stream_e2e_key_wraps w
      WHERE w.workspace_id = ${params.workspaceId}
        AND w.stream_id = ${params.streamId}
        AND w.recipient_kind = ${E2eKeyWrapRecipientKinds.BOT}
        AND EXISTS (
          SELECT 1 FROM runtime_e2e_key_holders h
          WHERE h.workspace_id = w.workspace_id AND h.bot_id = ${params.botId} AND h.key_id = w.recipient_key_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM runtime_e2e_key_holders h
          JOIN e2e_stream_actors a
            ON a.workspace_id = h.workspace_id AND a.stream_id = ${params.streamId}
            AND a.kind = 'bot' AND a.actor_id = h.bot_id
          WHERE h.workspace_id = w.workspace_id AND h.key_id = w.recipient_key_id
        )
    `)
    return result.rowCount ?? 0
  },
}
