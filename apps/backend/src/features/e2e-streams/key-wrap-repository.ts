import type { Querier } from "../../db"
import { sql } from "../../db"
import { streamE2eKeyWrapId } from "../../lib/id"
import type { E2eKeyWrapRecipientKind } from "@threa/types"

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
}
