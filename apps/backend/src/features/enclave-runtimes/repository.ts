import type { Querier } from "../../db"
import { sql } from "../../db"

/**
 * One row per registered enclave instance. Multiple instances may be live
 * concurrently (HA from day one); each polls the claim endpoint for work,
 * and the per-stream symmetric key (SSK) is HPKE-wrapped to every live EIK
 * so whichever instance claims a turn can decrypt the stream. Instances are
 * not addressable — the enclave runs no inbound listener (§2.7), so no URL
 * is registered.
 */
export interface EnclaveRuntime {
  id: string
  instanceId: string
  keyId: string
  publicKey: Uint8Array
  registeredAt: Date
  lastSeenAt: Date
  revokedAt: Date | null
}

interface EnclaveRuntimeRow {
  id: string
  instance_id: string
  key_id: string
  public_key: Buffer
  registered_at: Date
  last_seen_at: Date
  revoked_at: Date | null
}

const COLUMNS = "id, instance_id, key_id, public_key, registered_at, last_seen_at, revoked_at"

function mapRow(row: EnclaveRuntimeRow): EnclaveRuntime {
  return {
    id: row.id,
    instanceId: row.instance_id,
    keyId: row.key_id,
    publicKey: new Uint8Array(row.public_key),
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }
}

export interface RegisterEnclaveKeyParams {
  id: string
  instanceId: string
  keyId: string
  publicKey: Uint8Array
}

export const EnclaveRuntimesRepository = {
  /**
   * Register a brand-new EIK for an enclave instance. Key ids are globally
   * unique (INV-20: race-safe — `ON CONFLICT (key_id) DO UPDATE` refreshes
   * `last_seen_at` if the same instance restarts and re-presents its key id,
   * while remaining a no-op for an unrelated row).
   */
  async registerKey(db: Querier, params: RegisterEnclaveKeyParams): Promise<EnclaveRuntime> {
    const publicKey = Buffer.from(params.publicKey)
    const result = await db.query<EnclaveRuntimeRow>(sql`
      INSERT INTO enclave_runtimes (id, instance_id, key_id, public_key)
      VALUES (${params.id}, ${params.instanceId}, ${params.keyId}, ${publicKey})
      ON CONFLICT (key_id) DO UPDATE
        SET last_seen_at = NOW(),
            revoked_at = NULL
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return mapRow(result.rows[0]!)
  },

  /**
   * Bump `last_seen_at` for a heartbeat. Returns whether a live row existed.
   * Revoked rows are not resurrected by a heartbeat — that path goes through
   * `registerKey` (which clears `revoked_at`) so we don't accidentally
   * re-activate a tombstoned key.
   */
  async heartbeat(db: Querier, keyId: string): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE enclave_runtimes
      SET last_seen_at = NOW()
      WHERE key_id = ${keyId} AND revoked_at IS NULL
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * The live set: not revoked AND seen within the staleness window. The
   * frontend uses this (via `/enclave/active-keys`) to wrap the SSK to each
   * live EIK, so whichever instance claims a turn can decrypt. Sorted by
   * `last_seen_at DESC` so the freshest instance comes first (order isn't
   * load-bearing for correctness).
   */
  async listLive(db: Querier, stalenessMs: number): Promise<EnclaveRuntime[]> {
    const result = await db.query<EnclaveRuntimeRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM enclave_runtimes
      WHERE revoked_at IS NULL
        AND last_seen_at > NOW() - (${stalenessMs} * INTERVAL '1 millisecond')
      ORDER BY last_seen_at DESC
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Resolve one (non-revoked) runtime by its EIK key id — gates the claim
   * endpoint (only a registered, live EIK may claim) and classifies a
   * session's `server_id` as enclave-owned on the abort path. Returns null
   * if revoked or unknown.
   */
  async findByKeyId(db: Querier, keyId: string): Promise<EnclaveRuntime | null> {
    const result = await db.query<EnclaveRuntimeRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM enclave_runtimes
      WHERE key_id = ${keyId} AND revoked_at IS NULL
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Mark a key revoked. Idempotent: running this against an already-revoked
   * row keeps the original `revoked_at` timestamp.
   */
  async revoke(db: Querier, keyId: string): Promise<void> {
    await db.query(sql`
      UPDATE enclave_runtimes
      SET revoked_at = NOW()
      WHERE key_id = ${keyId} AND revoked_at IS NULL
    `)
  },
}
