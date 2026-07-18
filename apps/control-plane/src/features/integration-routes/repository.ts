import type { Querier } from "@threa/backend-common"

export interface IntegrationRouteRow {
  id: string
  provider: string
  external_id: string
  region: string
  workspace_id: string
  created_at: Date
}

export const IntegrationRouteRepository = {
  /**
   * Race-safe registration (INV-20). A re-install or backfill re-run hits the
   * (provider, external_id, workspace_id) unique key and refreshes region
   * rather than inserting a duplicate.
   */
  async upsert(
    db: Querier,
    route: { id: string; provider: string; externalId: string; region: string; workspaceId: string }
  ): Promise<IntegrationRouteRow> {
    const result = await db.query<IntegrationRouteRow>(
      `INSERT INTO integration_routes (id, provider, external_id, region, workspace_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, external_id, workspace_id)
       DO UPDATE SET region = EXCLUDED.region
       RETURNING id, provider, external_id, region, workspace_id, created_at`,
      [route.id, route.provider, route.externalId, route.region, route.workspaceId]
    )
    return result.rows[0]
  },

  async delete(db: Querier, route: { provider: string; externalId: string; workspaceId: string }): Promise<number> {
    const result = await db.query(
      `DELETE FROM integration_routes
       WHERE provider = $1 AND external_id = $2 AND workspace_id = $3`,
      [route.provider, route.externalId, route.workspaceId]
    )
    return result.rowCount ?? 0
  },

  /** Distinct regions hosting a subscribed workspace for this installation. */
  async listRegions(db: Querier, provider: string, externalId: string): Promise<string[]> {
    const result = await db.query<{ region: string }>(
      `SELECT DISTINCT region FROM integration_routes
       WHERE provider = $1 AND external_id = $2`,
      [provider, externalId]
    )
    return result.rows.map((r) => r.region)
  },
}
