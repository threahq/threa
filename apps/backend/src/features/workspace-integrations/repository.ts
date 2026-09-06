import { sql, type Querier } from "../../db"
import {
  WorkspaceIntegrationStatuses,
  type WorkspaceIntegrationProvider,
  type WorkspaceIntegrationStatus,
} from "@threahq/types"

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
  // Optimistic-concurrency generation. Incremented by every update/upsert; the
  // cache/credential write paths CAS on it (INV-66).
  version: number
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

/**
 * Which unique index the upsert arbitrates on. Multi-install providers (GitHub)
 * key on the (workspace, provider, installation) partial index; single-row
 * providers (Linear) key on the row's ULID so a reconnect to a different org
 * replaces the existing row rather than inserting a second one.
 */
export type WorkspaceIntegrationUpsertConflict = "provider-installation" | "id"

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
   * Optimistic generation guard (INV-66). When set, the write only lands if the
   * row's `version` still equals the value read before the out-of-transaction
   * network work — so a stale full-object write (rate-limit/credential/metadata)
   * can't clobber a newer concurrent write to the SAME row. A miss matches 0 rows
   * and returns null. Lifecycle writes (disconnect, deactivate, install/replace)
   * deliberately OMIT this: they express absolute user/webhook intent and must not
   * be no-op'd by a background refresh's version bump.
   */
  expectedVersion?: number
}

/**
 * Choose the upsert's conflict arbiter. GitHub is multi-install, so it keys on
 * the partial unique index that fits the row: (workspace, provider, installation)
 * for a real install, or (workspace, provider) for a legacy NULL-installation
 * row. Single-row providers (Linear) key on the row's own ULID so a reconnect to
 * a different external org replaces the row in place instead of colliding on the
 * primary key — Linear stores its org id in installation_id (non-null), which
 * would otherwise route it to the multi-install index and permit a second row
 * per distinct org id. The arbiter pins installation_id / keeps NULL, so
 * DO UPDATE writes it plainly.
 */
function upsertConflictClause(
  conflictTarget: WorkspaceIntegrationUpsertConflict,
  installationId: string | null
): string {
  if (conflictTarget === "id") return "ON CONFLICT (id)"
  if (installationId != null) {
    return "ON CONFLICT (workspace_id, provider, installation_id) WHERE installation_id IS NOT NULL"
  }
  return "ON CONFLICT (workspace_id, provider) WHERE installation_id IS NULL"
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
    version: (row.version as number | null) ?? 1,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

export const WorkspaceIntegrationRepository = {
  /** Serialize integration replacement even when no provider row exists yet. */
  async lockWorkspace(querier: Querier, workspaceId: string): Promise<void> {
    await querier.query(sql`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId])
  },

  /**
   * Single-row providers only (Linear); GitHub reads go through
   * listByWorkspaceAndProvider (one grandfathered exception: the inert
   * backfillGithubRoute, whose row set predates multi-install).
   */
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

  /** Address one integration row by its ULID (per-install handlers, any provider). */
  async findByWorkspaceAndId(
    querier: Querier,
    workspaceId: string,
    id: string
  ): Promise<WorkspaceIntegrationRecord | null> {
    const result = await querier.query(sql`SELECT * FROM workspace_integrations WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      id,
    ])
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Every integration row for a provider (GitHub is multi-install), oldest first. */
  async listByWorkspaceAndProvider(
    querier: Querier,
    workspaceId: string,
    provider: WorkspaceIntegrationProvider
  ): Promise<WorkspaceIntegrationRecord[]> {
    const result = await querier.query(
      sql`SELECT * FROM workspace_integrations
          WHERE workspace_id = $1 AND provider = $2
          ORDER BY created_at ASC, id ASC`,
      [workspaceId, provider]
    )
    return result.rows.map(mapRow)
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

  async upsert(
    querier: Querier,
    params: UpsertWorkspaceIntegrationParams,
    conflictTarget: WorkspaceIntegrationUpsertConflict = "provider-installation"
  ): Promise<WorkspaceIntegrationRecord> {
    const conflict = upsertConflictClause(conflictTarget, params.installationId ?? null)
    const result = await querier.query(
      `INSERT INTO workspace_integrations (
              id, workspace_id, provider, status, credentials, metadata, installed_by, installation_id
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
          ${conflict} DO UPDATE SET
              status = EXCLUDED.status,
              credentials = EXCLUDED.credentials,
              metadata = EXCLUDED.metadata,
              installed_by = EXCLUDED.installed_by,
              installation_id = EXCLUDED.installation_id,
              version = workspace_integrations.version + 1,
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

  /**
   * Guarded partial update, scoped to a SINGLE row by its installation id.
   * `installationScope` is the row's `installation_id` COLUMN value read before
   * the write (`IS NOT DISTINCT FROM` matches NULL to NULL), so with GitHub's N
   * rows per (workspace, provider) the write touches exactly the intended
   * installation — never a sibling. Pass the value observed at read (identity
   * pinned at read, INV-20); a reconnect to a different installation shifts the
   * column and the write correctly matches 0 rows.
   */
  async update(
    querier: Querier,
    workspaceId: string,
    provider: WorkspaceIntegrationProvider,
    installationScope: string | null,
    params: UpdateWorkspaceIntegrationParams,
    options?: UpdateWorkspaceIntegrationOptions
  ): Promise<WorkspaceIntegrationRecord | null> {
    const result = await querier.query(
      sql`UPDATE workspace_integrations
          SET
            status = COALESCE($4, status),
            credentials = COALESCE($5::jsonb, credentials),
            metadata = COALESCE($6::jsonb, metadata),
            installed_by = COALESCE($7, installed_by),
            installation_id = COALESCE($8, installation_id),
            version = version + 1,
            updated_at = NOW()
          WHERE workspace_id = $1 AND provider = $2
            AND installation_id IS NOT DISTINCT FROM $3
            AND ($9::text IS NULL OR status = $9)
            AND ($10::int IS NULL OR version = $10)
          RETURNING *`,
      [
        workspaceId,
        provider,
        installationScope,
        params.status ?? null,
        params.credentials ? JSON.stringify(params.credentials) : null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.installedBy ?? null,
        params.installationId ?? null,
        options?.expectedStatus ?? null,
        options?.expectedVersion ?? null,
      ]
    )

    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}
