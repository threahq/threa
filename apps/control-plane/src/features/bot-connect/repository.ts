import type { Querier } from "@threa/backend-common"

export const BOT_CONNECT_STATUSES = ["pending", "approved", "claimed", "denied"] as const
export type BotConnectStatus = (typeof BOT_CONNECT_STATUSES)[number]

export interface BotConnectRequestRow {
  id: string
  device_code_hash: string
  user_code: string
  client_id: string
  status: string
  requested_name: string | null
  requested_host: string | null
  approved_workspace_id: string | null
  approved_workspace_name: string | null
  approved_bot_id: string | null
  approved_bot_slug: string | null
  approved_scope: string | null
  approved_by_workos_user_id: string | null
  api_key: string | null
  created_at: Date
  expires_at: Date
  approved_at: Date | null
  claimed_at: Date | null
}

const SELECT_FIELDS = `id, device_code_hash, user_code, client_id, status, requested_name, requested_host,
  approved_workspace_id, approved_workspace_name, approved_bot_id, approved_bot_slug, approved_scope,
  approved_by_workos_user_id, api_key, created_at, expires_at, approved_at, claimed_at`

export const BotConnectRepository = {
  /** False when the user code collides with another pending request (the caller mints a new one). */
  async insert(
    db: Querier,
    row: {
      id: string
      deviceCodeHash: string
      userCode: string
      clientId: string
      requestedName: string | null
      requestedHost: string | null
      expiresAt: Date
    }
  ): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO bot_connect_requests (id, device_code_hash, user_code, client_id, requested_name, requested_host, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [row.id, row.deviceCodeHash, row.userCode, row.clientId, row.requestedName, row.requestedHost, row.expiresAt]
    )
    return (result.rowCount ?? 0) > 0
  },

  async findByDeviceCodeHash(db: Querier, hash: string): Promise<BotConnectRequestRow | null> {
    const result = await db.query<BotConnectRequestRow>(
      `SELECT ${SELECT_FIELDS} FROM bot_connect_requests WHERE device_code_hash = $1`,
      [hash]
    )
    return result.rows[0] ?? null
  },

  async findPendingByUserCode(db: Querier, userCode: string): Promise<BotConnectRequestRow | null> {
    const result = await db.query<BotConnectRequestRow>(
      `SELECT ${SELECT_FIELDS} FROM bot_connect_requests WHERE user_code = $1 AND status = 'pending'`,
      [userCode]
    )
    return result.rows[0] ?? null
  },

  /**
   * pending → approved, only while still pending and unexpired (INV-20: the
   * status predicate is the guard, so two approvals cannot both win). The
   * device gets five more minutes to collect the result.
   */
  async approve(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      workspaceName: string
      botId: string
      botSlug: string
      scope: string
      apiKey: string
      approvedByWorkosUserId: string
    }
  ): Promise<BotConnectRequestRow | null> {
    const result = await db.query<BotConnectRequestRow>(
      `UPDATE bot_connect_requests
       SET status = 'approved', approved_workspace_id = $2, approved_workspace_name = $3,
           approved_bot_id = $4, approved_bot_slug = $5, approved_scope = $6, api_key = $7,
           approved_by_workos_user_id = $8,
           approved_at = NOW(), expires_at = GREATEST(expires_at, NOW() + INTERVAL '5 minutes')
       WHERE id = $1 AND status = 'pending' AND expires_at > NOW()
       RETURNING ${SELECT_FIELDS}`,
      [
        params.id,
        params.workspaceId,
        params.workspaceName,
        params.botId,
        params.botSlug,
        params.scope,
        params.apiKey,
        params.approvedByWorkosUserId,
      ]
    )
    return result.rows[0] ?? null
  },

  async deny(db: Querier, id: string, byWorkosUserId: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE bot_connect_requests
       SET status = 'denied', approved_by_workos_user_id = $2
       WHERE id = $1 AND status = 'pending'`,
      [id, byWorkosUserId]
    )
    return (result.rowCount ?? 0) > 0
  },

  /**
   * approved → claimed, returning the key exactly once: the RETURNING row
   * carries it, the stored column is nulled in the same statement.
   */
  async claim(db: Querier, id: string): Promise<BotConnectRequestRow | null> {
    const result = await db.query<BotConnectRequestRow>(
      `UPDATE bot_connect_requests AS r
       SET status = 'claimed', claimed_at = NOW(), api_key = NULL
       FROM (SELECT id, api_key FROM bot_connect_requests WHERE id = $1 AND status = 'approved' AND expires_at > NOW() FOR UPDATE) AS prior
       WHERE r.id = prior.id
       RETURNING r.id, r.device_code_hash, r.user_code, r.client_id, r.status, r.requested_name, r.requested_host,
         r.approved_workspace_id, r.approved_workspace_name, r.approved_bot_id, r.approved_bot_slug, r.approved_scope,
         r.approved_by_workos_user_id, prior.api_key AS api_key, r.created_at, r.expires_at, r.approved_at, r.claimed_at`,
      [id]
    )
    return result.rows[0] ?? null
  },

  /** An expired request keeps nothing: the key it may hold is dropped the moment expiry is observed. */
  async clearKey(db: Querier, id: string): Promise<void> {
    await db.query(`UPDATE bot_connect_requests SET api_key = NULL WHERE id = $1`, [id])
  },

  /** Drop expired rows (and any key they still hold). Runs on every authorization and on the sweeper. */
  async purgeExpired(db: Querier): Promise<void> {
    await db.query(`DELETE FROM bot_connect_requests WHERE expires_at < NOW()`)
  },
}
