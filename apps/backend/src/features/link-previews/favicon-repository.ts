import { sql, type Querier } from "@threahq/backend-common"

export interface LinkFavicon {
  workspaceId: string
  host: string
  contentType: string | null
  bytes: Buffer | null
  fetchedAt: Date
  expiresAt: Date
}

interface LinkFaviconRow {
  workspace_id: string
  host: string
  content_type: string | null
  bytes: Buffer | null
  fetched_at: Date
  expires_at: Date
}

function mapRow(row: LinkFaviconRow): LinkFavicon {
  return {
    workspaceId: row.workspace_id,
    host: row.host,
    contentType: row.content_type,
    bytes: row.bytes,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  }
}

export const LinkFaviconRepository = {
  async find(querier: Querier, workspaceId: string, host: string): Promise<LinkFavicon | null> {
    const result = await querier.query<LinkFaviconRow>(
      sql`SELECT * FROM link_favicons WHERE workspace_id = $1 AND host = $2`,
      [workspaceId, host]
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async storeIcon(
    querier: Querier,
    params: { workspaceId: string; host: string; contentType: string; bytes: Uint8Array; expiresAt: Date }
  ): Promise<void> {
    await querier.query(
      sql`INSERT INTO link_favicons (workspace_id, host, content_type, bytes, fetched_at, expires_at)
          VALUES ($1, $2, $3, $4, NOW(), $5)
          ON CONFLICT (workspace_id, host) DO UPDATE SET
            content_type = EXCLUDED.content_type,
            bytes = EXCLUDED.bytes,
            fetched_at = EXCLUDED.fetched_at,
            expires_at = EXCLUDED.expires_at`,
      [params.workspaceId, params.host, params.contentType, Buffer.from(params.bytes), params.expiresAt]
    )
  },

  async recordMiss(querier: Querier, params: { workspaceId: string; host: string; expiresAt: Date }): Promise<void> {
    await querier.query(
      sql`INSERT INTO link_favicons (workspace_id, host, fetched_at, expires_at)
          VALUES ($1, $2, NOW(), $3)
          ON CONFLICT (workspace_id, host) DO UPDATE SET
            fetched_at = EXCLUDED.fetched_at,
            expires_at = EXCLUDED.expires_at`,
      [params.workspaceId, params.host, params.expiresAt]
    )
  },
}
