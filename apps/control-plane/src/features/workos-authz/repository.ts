import type { Querier } from "@threahq/backend-common"

export interface WorkosOrgMembershipRow {
  workos_organization_id: string
  workos_user_id: string
  organization_membership_id: string
  status: string
  role_slugs: string[]
  last_event_id: string | null
  last_event_at: Date
  created_at: Date
  updated_at: Date
}

export interface UpsertMembershipFromEventInput {
  organizationMembershipId: string
  workosOrganizationId: string
  workosUserId: string
  status: string
  roleSlugs: string[]
  eventId: string
  eventCreatedAt: Date
}

export interface UpsertMembershipFromBackfillInput {
  organizationMembershipId: string
  workosOrganizationId: string
  workosUserId: string
  status: string
  roleSlugs: string[]
  /** Stamped onto last_event_at; backfill is last-write-wins. */
  observedAt: Date
}

const SELECT_FIELDS = `
  workos_organization_id,
  workos_user_id,
  organization_membership_id,
  status,
  role_slugs,
  last_event_id,
  last_event_at,
  created_at,
  updated_at
`

export const WorkosAuthzRepository = {
  /**
   * Race-safe upsert from a WorkOS event (INV-20). A `last_event_at` timestamp
   * guard rejects stale or duplicated events: we only overwrite when the
   * incoming event is strictly newer than what we've already persisted.
   * Returns the row only when an actual change was applied — useful for
   * tests and metrics.
   */
  async upsertMembershipFromEvent(
    db: Querier,
    input: UpsertMembershipFromEventInput
  ): Promise<WorkosOrgMembershipRow | null> {
    const result = await db.query<WorkosOrgMembershipRow>(
      `INSERT INTO workos_organization_memberships (
         workos_organization_id,
         workos_user_id,
         organization_membership_id,
         status,
         role_slugs,
         last_event_id,
         last_event_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workos_organization_id, workos_user_id) DO UPDATE SET
         organization_membership_id = EXCLUDED.organization_membership_id,
         status = EXCLUDED.status,
         role_slugs = EXCLUDED.role_slugs,
         last_event_id = EXCLUDED.last_event_id,
         last_event_at = EXCLUDED.last_event_at,
         updated_at = NOW()
       WHERE workos_organization_memberships.last_event_at < EXCLUDED.last_event_at
       RETURNING ${SELECT_FIELDS}`,
      [
        input.workosOrganizationId,
        input.workosUserId,
        input.organizationMembershipId,
        input.status,
        input.roleSlugs,
        input.eventId,
        input.eventCreatedAt,
      ]
    )
    return result.rows[0] ?? null
  },

  /**
   * Backfill upsert: last-write-wins, no timestamp guard. The operator running
   * backfill is the source of truth for that moment. Stamps `last_event_id`
   * to NULL so a subsequent event-driven update can compare timestamps cleanly.
   */
  async upsertMembershipFromBackfill(
    db: Querier,
    input: UpsertMembershipFromBackfillInput
  ): Promise<WorkosOrgMembershipRow> {
    const result = await db.query<WorkosOrgMembershipRow>(
      `INSERT INTO workos_organization_memberships (
         workos_organization_id,
         workos_user_id,
         organization_membership_id,
         status,
         role_slugs,
         last_event_id,
         last_event_at
       )
       VALUES ($1, $2, $3, $4, $5, NULL, $6)
       ON CONFLICT (workos_organization_id, workos_user_id) DO UPDATE SET
         organization_membership_id = EXCLUDED.organization_membership_id,
         status = EXCLUDED.status,
         role_slugs = EXCLUDED.role_slugs,
         last_event_id = NULL,
         last_event_at = EXCLUDED.last_event_at,
         updated_at = NOW()
       RETURNING ${SELECT_FIELDS}`,
      [
        input.workosOrganizationId,
        input.workosUserId,
        input.organizationMembershipId,
        input.status,
        input.roleSlugs,
        input.observedAt,
      ]
    )
    return result.rows[0]
  },

  /**
   * Delete with the same timestamp guard as upsert (INV-20). Only removes the
   * row when the deletion event is newer than the persisted state.
   */
  async deleteMembership(
    db: Querier,
    params: { workosOrganizationId: string; workosUserId: string; eventCreatedAt: Date }
  ): Promise<boolean> {
    const result = await db.query(
      `DELETE FROM workos_organization_memberships
       WHERE workos_organization_id = $1
         AND workos_user_id = $2
         AND last_event_at < $3`,
      [params.workosOrganizationId, params.workosUserId, params.eventCreatedAt]
    )
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Reconcile a backfill snapshot for one organization: delete mirror rows
   * whose `organization_membership_id` is absent from the snapshot. The
   * `last_event_at <= observedAt` guard preserves rows the poller wrote
   * concurrently after we took the snapshot, so a brand-new membership added
   * during backfill survives instead of being silently deleted.
   *
   * An empty snapshot deletes every (non-fresher) row for the org — that's
   * intentional: a successful WorkOS list returning zero memberships means the
   * org genuinely has none.
   *
   * Returns the deleted rows so the caller can emit fan-out events for each
   * removal.
   */
  async reconcileOrganizationSnapshotReturning(
    db: Querier,
    params: {
      workosOrganizationId: string
      snapshotMembershipIds: string[]
      observedAt: Date
    }
  ): Promise<WorkosOrgMembershipRow[]> {
    const result = await db.query<WorkosOrgMembershipRow>(
      `DELETE FROM workos_organization_memberships
       WHERE workos_organization_id = $1
         AND organization_membership_id <> ALL($2::text[])
         AND last_event_at <= $3
       RETURNING ${SELECT_FIELDS}`,
      [params.workosOrganizationId, params.snapshotMembershipIds, params.observedAt]
    )
    return result.rows
  },

  async listByOrganization(db: Querier, workosOrganizationId: string): Promise<WorkosOrgMembershipRow[]> {
    const result = await db.query<WorkosOrgMembershipRow>(
      `SELECT ${SELECT_FIELDS}
       FROM workos_organization_memberships
       WHERE workos_organization_id = $1
       ORDER BY created_at ASC`,
      [workosOrganizationId]
    )
    return result.rows
  },

  async getByOrgAndUser(
    db: Querier,
    workosOrganizationId: string,
    workosUserId: string
  ): Promise<WorkosOrgMembershipRow | null> {
    const result = await db.query<WorkosOrgMembershipRow>(
      `SELECT ${SELECT_FIELDS}
       FROM workos_organization_memberships
       WHERE workos_organization_id = $1 AND workos_user_id = $2`,
      [workosOrganizationId, workosUserId]
    )
    return result.rows[0] ?? null
  },

  /**
   * One-shot owner backfill: workspaces whose creator is not yet recorded as
   * an `owner` in the mirror. LEFT JOIN keeps workspaces where the creator
   * has no membership row at all (mirror gap); `COALESCE(... ANY(...), false)`
   * is needed because `ANY(NULL)` evaluates to NULL, not false.
   */
  async findWorkspaceCreatorsMissingOwnerRole(db: Querier): Promise<
    Array<{
      workspaceId: string
      workosOrganizationId: string
      createdByWorkosUserId: string
      organizationMembershipId: string | null
      roleSlugs: string[]
    }>
  > {
    const result = await db.query<{
      workspace_id: string
      workos_organization_id: string
      created_by_workos_user_id: string
      organization_membership_id: string | null
      role_slugs: string[] | null
    }>(
      `SELECT wr.id AS workspace_id,
              wr.workos_organization_id,
              wr.created_by_workos_user_id,
              wom.organization_membership_id,
              wom.role_slugs
       FROM workspace_registry wr
       LEFT JOIN workos_organization_memberships wom
         ON wom.workos_organization_id = wr.workos_organization_id
         AND wom.workos_user_id = wr.created_by_workos_user_id
       WHERE wr.workos_organization_id IS NOT NULL
         AND NOT COALESCE('owner' = ANY(wom.role_slugs), false)
       ORDER BY wr.created_at ASC`
    )
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      workosOrganizationId: row.workos_organization_id,
      createdByWorkosUserId: row.created_by_workos_user_id,
      organizationMembershipId: row.organization_membership_id,
      roleSlugs: row.role_slugs ?? [],
    }))
  },

  /**
   * Count members of an org holding `role_slug`, optionally excluding one user.
   * Used by the last-owner guard: a `SELECT 1` filtered by role is bounded
   * regardless of org size, where `listByOrganization` would hydrate every row.
   */
  async countByRoleExcludingUser(
    db: Querier,
    params: { workosOrganizationId: string; roleSlug: string; excludeWorkosUserId: string }
  ): Promise<number> {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM workos_organization_memberships
       WHERE workos_organization_id = $1
         AND workos_user_id <> $2
         AND $3 = ANY(role_slugs)`,
      [params.workosOrganizationId, params.excludeWorkosUserId, params.roleSlug]
    )
    return Number(result.rows[0]?.count ?? 0)
  },
}
