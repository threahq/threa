import { sql, type Querier } from "../../db"
import {
  WorkspaceIntegrationStatuses,
  type WorkspaceIntegrationProvider,
  type WorkspaceIntegrationStatus,
} from "@threa/types"

export interface WorkspaceIntegrationRecord {
  id: string
  workspaceId: string
  provider: WorkspaceIntegrationProvider
  status: WorkspaceIntegrationStatus
  credentials: Record<string, unknown>
  metadata: Record<string, unknown>
  installedBy: string
  // Plaintext reverse index for webhook fan-out (GitHub installation id as
  // text). Null on pre-backfill rows and for providers without one.
  installationId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface UpsertWorkspaceIntegrationParams {
  id: string
  workspaceId: string
  provider: WorkspaceIntegrationProvider
  status: WorkspaceIntegrationStatus
  credentials: Record<string, unknown>
  metadata: Record<string, unknown>
  installedBy: string
  installationId?: string | null
}

export interface UpdateWorkspaceIntegrationParams {
  status?: WorkspaceIntegrationStatus
  credentials?: Record<string, unknown>
  metadata?: Record<string, unknown>
  installedBy?: string
  installationId?: string | null
}

export interface UpdateWorkspaceIntegrationOptions {
  expectedStatus?: WorkspaceIntegrationStatus
  /**
   * Optimistic guard on the current `installation_id`, so a write can't clobber a
   * row that disconnected + reconnected to a DIFFERENT installation in between.
   * `allowNull: true` also matches a pre-backfill NULL column (the backfill path
   * fills the column, so its own value or NULL is the legitimate "before"); the
   * deactivation path passes `allowNull: false` to require an EXACT match on the
   * installation it listed.
   */
  expectedInstallationId?: { value: string; allowNull: boolean }
}

function mapRow(row: Record<string, unknown>): WorkspaceIntegrationRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    provider: row.provider as WorkspaceIntegrationProvider,
    status: row.status as WorkspaceIntegrationStatus,
    credentials: (row.credentials as Record<string, unknown> | null) ?? {},
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    installedBy: row.installed_by as string,
    installationId: (row.installation_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

export const WorkspaceIntegrationRepository = {
  /** Serialize integration replacement even when no provider row exists yet. */
  async lockWorkspace(querier: Querier, workspaceId: string): Promise<void> {
    await querier.query(sql`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId])
  },

  async findByWorkspaceAndProvider(
    querier: Querier,
    workspaceId: string,
    provider: WorkspaceIntegrationProvider
  ): Promise<WorkspaceIntegrationRecord | null> {
    const result = await querier.query(
      sql`SELECT * FROM workspace_integrations WHERE workspace_id = $1 AND provider = $2`,
      [workspaceId, provider]
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Reverse index for webhook fan-out: every active integration for a provider's
   * installation id. Multiple workspaces per installation is the normal case
   * (GitHub installs are per org, not per workspace), so this returns a list.
   */
  async listActiveByInstallationId(
    querier: Querier,
    provider: WorkspaceIntegrationProvider,
    installationId: string
  ): Promise<WorkspaceIntegrationRecord[]> {
    const result = await querier.query(
      sql`SELECT * FROM workspace_integrations
          WHERE provider = $1 AND installation_id = $2 AND status = $3`,
      [provider, installationId, WorkspaceIntegrationStatuses.ACTIVE]
    )
    return result.rows.map(mapRow)
  },

  async upsert(querier: Querier, params: UpsertWorkspaceIntegrationParams): Promise<WorkspaceIntegrationRecord> {
    const result = await querier.query(
      sql`INSERT INTO workspace_integrations (
              id, workspace_id, provider, status, credentials, metadata, installed_by, installation_id
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
          ON CONFLICT (workspace_id, provider) DO UPDATE SET
              status = EXCLUDED.status,
              credentials = EXCLUDED.credentials,
              metadata = EXCLUDED.metadata,
              installed_by = EXCLUDED.installed_by,
              installation_id = COALESCE(EXCLUDED.installation_id, workspace_integrations.installation_id),
              updated_at = NOW()
          RETURNING *`,
      [
        params.id,
        params.workspaceId,
        params.provider,
        params.status,
        JSON.stringify(params.credentials),
        JSON.stringify(params.metadata),
        params.installedBy,
        params.installationId ?? null,
      ]
    )

    return mapRow(result.rows[0])
  },

  async update(
    querier: Querier,
    workspaceId: string,
    provider: WorkspaceIntegrationProvider,
    params: UpdateWorkspaceIntegrationParams,
    options?: UpdateWorkspaceIntegrationOptions
  ): Promise<WorkspaceIntegrationRecord | null> {
    const installationGuard = options?.expectedInstallationId
    const result = await querier.query(
      sql`UPDATE workspace_integrations
          SET
            status = COALESCE($3, status),
            credentials = COALESCE($4::jsonb, credentials),
            metadata = COALESCE($5::jsonb, metadata),
            installed_by = COALESCE($6, installed_by),
            installation_id = COALESCE($8, installation_id),
            updated_at = NOW()
          WHERE workspace_id = $1 AND provider = $2
            AND ($7::text IS NULL OR status = $7)
            AND (
              $9::boolean
              OR ($11::boolean AND (installation_id IS NULL OR installation_id = $10))
              OR ((NOT $11::boolean) AND installation_id IS NOT DISTINCT FROM $10)
            )
          RETURNING *`,
      [
        workspaceId,
        provider,
        params.status ?? null,
        params.credentials ? JSON.stringify(params.credentials) : null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.installedBy ?? null,
        options?.expectedStatus ?? null,
        params.installationId ?? null,
        installationGuard ? false : true,
        installationGuard?.value ?? null,
        installationGuard?.allowNull ?? false,
      ]
    )

    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}
