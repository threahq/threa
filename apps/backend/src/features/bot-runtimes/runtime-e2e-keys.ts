import { HttpError } from "@threahq/backend-common"
import { sql, type Querier } from "../../db"

/** A key as a runtime advertises it on hello/presence. */
export interface RuntimeE2eKeyRegistration {
  keyId: string
  publicKey: string
  /** Pins the key to one sealed root stream; null/absent means every stream. */
  streamId?: string | null
}

export interface RuntimeE2eKey {
  keyId: string
  publicKey: string
  streamId: string | null
}

interface RuntimeE2eKeyRow {
  key_id: string
  public_key: string
  stream_id: string | null
}

const mapKey = (row: RuntimeE2eKeyRow): RuntimeE2eKey => ({
  keyId: row.key_id,
  publicKey: row.public_key,
  streamId: row.stream_id,
})

export const RuntimeE2eKeysRepository = {
  /**
   * Make `keys` the complete set this instance holds: register anything new and
   * drop holder rows for keys it no longer advertises, so a runtime that
   * unloads a key stops receiving wraps for it. Replacement rather than merge
   * mirrors the presence write it rides along with — a heartbeat that carries a
   * keyring states the whole keyring.
   *
   * A key id already registered with different public key material is rejected
   * (INV-11): the id is the wrap address, so silently rebinding it would point
   * a future roll's wraps at whoever re-registered the id last.
   *
   * Key rows are never deleted. They are addressed by wraps that outlive any
   * instance, and a runtime that comes back holding the same key must find the
   * same row.
   *
   * Returns the key ids this instance did not already hold. A steady heartbeat
   * re-advertising the same keyring returns none, which is what keeps the
   * missing-wrap nudge off the per-heartbeat path.
   */
  async replaceInstanceKeys(
    db: Querier,
    params: { workspaceId: string; botId: string; instanceId: string; keys: RuntimeE2eKeyRegistration[] }
  ): Promise<string[]> {
    const keyIds = params.keys.map((key) => key.keyId)
    let newlyHeld: string[] = []

    if (params.keys.length > 0) {
      const accepted = await db.query<{ key_id: string }>(sql`
        INSERT INTO runtime_e2e_keys (workspace_id, key_id, public_key, stream_id)
        SELECT ${params.workspaceId}, k.key_id, k.public_key, k.stream_id
        FROM unnest(${keyIds}::text[], ${params.keys.map((key) => key.publicKey)}::text[], ${params.keys.map((key) => key.streamId ?? null)}::text[])
          AS k(key_id, public_key, stream_id)
        ON CONFLICT (workspace_id, key_id) DO UPDATE SET stream_id = EXCLUDED.stream_id
        WHERE runtime_e2e_keys.public_key = EXCLUDED.public_key
        RETURNING key_id
      `)
      if (accepted.rows.length !== params.keys.length) {
        const rebound = keyIds.filter((keyId) => !accepted.rows.some((row) => row.key_id === keyId))
        throw new HttpError(`E2E key id already registered with different key material: ${rebound.join(", ")}`, {
          status: 409,
          code: "E2E_KEY_ID_CONFLICT",
        })
      }

      const held = await db.query<{ key_id: string }>(sql`
        INSERT INTO runtime_e2e_key_holders (workspace_id, key_id, bot_id, instance_id)
        SELECT ${params.workspaceId}, key_id, ${params.botId}, ${params.instanceId}
        FROM unnest(${keyIds}::text[]) AS key_id
        ON CONFLICT DO NOTHING
        RETURNING key_id
      `)
      newlyHeld = held.rows.map((row) => row.key_id)
    }

    await db.query(sql`
      DELETE FROM runtime_e2e_key_holders
      WHERE workspace_id = ${params.workspaceId}
        AND bot_id = ${params.botId}
        AND instance_id = ${params.instanceId}
        AND NOT (key_id = ANY(${keyIds}::text[]))
    `)

    return newlyHeld
  },

  /**
   * Every key a bot's live instances currently hold that may be wrapped for
   * `streamId`, deduplicated by key id — two instances sharing one key file are
   * one recipient, not two. "Live" mirrors the enclave model (recently seen,
   * not offline) so a roll wraps to every key that could claim an invocation.
   */
  async listLiveForBot(
    db: Querier,
    params: { workspaceId: string; botId: string; streamId: string; stalenessMs: number }
  ): Promise<RuntimeE2eKey[]> {
    const result = await db.query<RuntimeE2eKeyRow>(sql`
      SELECT DISTINCT k.key_id, k.public_key, k.stream_id
      FROM runtime_e2e_key_holders h
      JOIN runtime_e2e_keys k ON k.workspace_id = h.workspace_id AND k.key_id = h.key_id
      JOIN bot_runtime_instances ri
        ON ri.workspace_id = h.workspace_id AND ri.bot_id = h.bot_id AND ri.instance_id = h.instance_id
      WHERE h.workspace_id = ${params.workspaceId}
        AND h.bot_id = ${params.botId}
        AND (k.stream_id IS NULL OR k.stream_id = ${params.streamId})
        AND ri.status <> 'offline'
        AND ri.last_seen_at > NOW() - (${params.stalenessMs} || ' milliseconds')::interval
      ORDER BY k.key_id
    `)
    return result.rows.map(mapKey)
  },

  /**
   * The key ids one instance may use to open a turn on `streamId`,
   * stream-scoped keys first so a turn seals under the narrowest key the
   * runtime holds. Liveness is deliberately not checked: the caller is serving
   * an instance that just claimed, which is proof enough that it is here.
   */
  async listEligibleKeyIdsForInstance(
    db: Querier,
    params: { workspaceId: string; botId: string; instanceId: string; streamId: string }
  ): Promise<string[]> {
    const result = await db.query<{ key_id: string }>(sql`
      SELECT k.key_id
      FROM runtime_e2e_key_holders h
      JOIN runtime_e2e_keys k ON k.workspace_id = h.workspace_id AND k.key_id = h.key_id
      WHERE h.workspace_id = ${params.workspaceId}
        AND h.bot_id = ${params.botId}
        AND h.instance_id = ${params.instanceId}
        AND (k.stream_id IS NULL OR k.stream_id = ${params.streamId})
      ORDER BY k.stream_id NULLS LAST, k.key_id
    `)
    return result.rows.map((row) => row.key_id)
  },
}
