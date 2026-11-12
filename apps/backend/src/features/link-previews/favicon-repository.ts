import { composeSql, sql, type Querier } from "../../db"
import { escapeLikePattern } from "../../lib/sql-filters"
import { DocReferenceTypes } from "../docs"
import { streamAccessPredicateSql } from "../streams"

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

  /**
   * Whether the user can read an undeleted message or a doc that links to this host. A preview is on a
   * host exactly when its normalized URL starts with `scheme://host/`: normalization keeps the host and
   * the root slash. A doc links a host through its `link_origin` references (`scheme://host`). Access is
   * checked once per linking stream or doc, not per message or block, so the cost follows the host's
   * link count and never the size of the streams the user reads.
   */
  async isHostLinkedInReadableStream(
    querier: Querier,
    workspaceId: string,
    userId: string,
    host: string
  ): Promise<boolean> {
    const origins = ["http", "https"].map((scheme) => `${scheme}://${host}`)
    const [httpPrefix, httpsPrefix] = origins.map((origin) => `${escapeLikePattern(`${origin}/`)}%`)
    const result = await querier.query<{ readable: boolean }>(
      composeSql`SELECT EXISTS (
        SELECT 1
        FROM (
          SELECT DISTINCT m.stream_id
          FROM link_previews lp
          JOIN message_link_previews mlp
            ON mlp.workspace_id = lp.workspace_id AND mlp.link_preview_id = lp.id
          JOIN messages m ON m.workspace_id = mlp.workspace_id AND m.id = mlp.message_id
          WHERE lp.workspace_id = ${workspaceId}
            AND (lp.normalized_url LIKE ${httpPrefix} OR lp.normalized_url LIKE ${httpsPrefix})
            AND m.deleted_at IS NULL
        ) linked
        WHERE ${streamAccessPredicateSql(workspaceId, userId, "linked.stream_id")}
      ) OR EXISTS (
        SELECT 1
        FROM (
          SELECT DISTINCT dr.doc_id
          FROM doc_references dr
          WHERE dr.workspace_id = ${workspaceId}
            AND dr.ref_type = ${DocReferenceTypes.LINK_ORIGIN}
            AND dr.ref_id = ANY(${origins})
        ) linked_docs
        WHERE ${streamAccessPredicateSql(workspaceId, userId, "linked_docs.doc_id")}
      ) AS readable`
    )
    return result.rows[0].readable
  },

  /**
   * Hosts linked on the given doc blocks that have no unexpired icon or miss, each with the origin to fetch:
   * https when the doc links the host under both schemes.
   */
  async listUncachedDocLinkOrigins(
    querier: Querier,
    workspaceId: string,
    docId: string,
    blockIds: readonly string[]
  ): Promise<Array<{ host: string; origin: string }>> {
    const result = await querier.query<{ host: string; origin: string }>(
      sql`SELECT DISTINCT ON (linked.host) linked.host, linked.origin
          FROM (
            SELECT split_part(dr.ref_id, '://', 2) AS host, dr.ref_id AS origin
            FROM doc_references dr
            WHERE dr.workspace_id = $1 AND dr.doc_id = $2 AND dr.ref_type = $4
              AND dr.block_id = ANY($3::text[])
          ) linked
          WHERE NOT EXISTS (
            SELECT 1 FROM link_favicons lf
            WHERE lf.workspace_id = $1 AND lf.host = linked.host AND lf.expires_at > NOW()
          )
          ORDER BY linked.host, (linked.origin LIKE 'https://%') DESC`,
      [workspaceId, docId, [...blockIds], DocReferenceTypes.LINK_ORIGIN]
    )
    return result.rows
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
