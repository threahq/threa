import type { Querier } from "../../db"
import { sql } from "../../db"
import type { InvitationStatus, WorkspaceInvitableRole, WorkspaceInvitationKind } from "@threahq/types"

interface InvitationRow {
  id: string
  workspace_id: string
  kind: string
  email: string | null
  role: string
  invited_by: string
  workos_invitation_id: string | null
  token_hash: string | null
  note: string | null
  status: string
  created_at: Date
  expires_at: Date | null
  accepted_at: Date | null
  revoked_at: Date | null
  parent_link_id: string | null
  max_uses: number | null
  accepted_workos_user_id: string | null
  acceptance_consumes_capacity: boolean | null
  revision: number
  use_count: number
}

export interface Invitation {
  id: string
  workspaceId: string
  kind: WorkspaceInvitationKind
  email: string | null
  role: WorkspaceInvitableRole
  invitedBy: string
  workosInvitationId: string | null
  tokenHash: string | null
  note: string | null
  status: InvitationStatus
  createdAt: Date
  expiresAt: Date | null
  acceptedAt: Date | null
  revokedAt: Date | null
  parentLinkId: string | null
  maxUses: number | null
  useCount: number
  acceptedWorkosUserId: string | null
  acceptanceConsumesCapacity: boolean | null
  revision: number
}

export interface InsertEmailInvitationParams {
  id: string
  workspaceId: string
  email: string
  role: WorkspaceInvitableRole
  invitedBy: string
  expiresAt: Date
}

export interface InsertLinkInvitationParams {
  id: string
  workspaceId: string
  role: WorkspaceInvitableRole
  invitedBy: string
  tokenHash: string
  note: string | null
  expiresAt: Date | null
  maxUses: number | null
}

function mapRow(row: InvitationRow): Invitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as WorkspaceInvitationKind,
    email: row.email,
    role: row.role as WorkspaceInvitableRole,
    invitedBy: row.invited_by,
    workosInvitationId: row.workos_invitation_id,
    tokenHash: row.token_hash,
    note: row.note,
    status: row.status as InvitationStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    parentLinkId: row.parent_link_id,
    maxUses: row.max_uses,
    useCount: Number(row.use_count),
    acceptedWorkosUserId: row.accepted_workos_user_id,
    acceptanceConsumesCapacity: row.acceptance_consumes_capacity,
    revision: row.revision,
  }
}

const USE_COUNT_EXPR = (alias: string) => `
  CASE WHEN ${alias}.kind = 'link' AND ${alias}.parent_link_id IS NULL THEN
    (CASE WHEN ${alias}.accepted_at IS NOT NULL AND ${alias}.acceptance_consumes_capacity IS DISTINCT FROM FALSE THEN 1 ELSE 0 END) +
    (SELECT COUNT(*)::int FROM workspace_invitations child
     WHERE child.workspace_id = ${alias}.workspace_id
       AND child.parent_link_id = ${alias}.id
       AND child.accepted_at IS NOT NULL
       AND child.acceptance_consumes_capacity IS DISTINCT FROM FALSE)
  ELSE 0 END`

const SELECT_FIELDS = `
  wi.id, wi.workspace_id, wi.kind, wi.email, wi.role, wi.invited_by,
  wi.workos_invitation_id, wi.token_hash, wi.note, wi.status, wi.created_at,
  wi.expires_at, wi.accepted_at, wi.revoked_at, wi.parent_link_id, wi.max_uses,
  wi.accepted_workos_user_id, wi.acceptance_consumes_capacity, wi.revision,
  ${USE_COUNT_EXPR("wi")} AS use_count`

/** Parents without remaining capacity are not pending, matching the CP shadow filter. */
const PARENT_HAS_CAPACITY = `(parent.id IS NULL OR parent.max_uses IS NULL OR ${USE_COUNT_EXPR("parent")} < parent.max_uses)`

async function findById(db: Querier, id: string, forUpdate = false): Promise<Invitation | null> {
  if (forUpdate) {
    const locked = await db.query(sql`SELECT id FROM workspace_invitations WHERE id = ${id} FOR UPDATE`)
    if (locked.rows.length === 0) return null
  }
  const result = await db.query<InvitationRow>(sql`
    SELECT ${sql.raw(SELECT_FIELDS)}
    FROM workspace_invitations wi
    WHERE wi.id = ${id}
  `)
  return result.rows[0] ? mapRow(result.rows[0]) : null
}

export const InvitationRepository = {
  async insert(db: Querier, params: InsertEmailInvitationParams): Promise<Invitation> {
    const result = await db.query<InvitationRow>(sql`
      INSERT INTO workspace_invitations (id, workspace_id, kind, email, role, invited_by, expires_at, max_uses)
      VALUES (${params.id}, ${params.workspaceId}, 'email', ${params.email}, ${params.role}, ${params.invitedBy}, ${params.expiresAt}, NULL)
      RETURNING id, workspace_id, kind, email, role, invited_by, workos_invitation_id, token_hash, note,
        status, created_at, expires_at, accepted_at, revoked_at, parent_link_id, max_uses,
        accepted_workos_user_id, acceptance_consumes_capacity, revision, 0::int AS use_count
    `)
    return mapRow(result.rows[0])
  },

  async insertLink(db: Querier, params: InsertLinkInvitationParams): Promise<Invitation> {
    const result = await db.query<InvitationRow>(sql`
      INSERT INTO workspace_invitations
        (id, workspace_id, kind, email, role, invited_by, token_hash, note, expires_at, max_uses)
      VALUES
        (${params.id}, ${params.workspaceId}, 'link', NULL, ${params.role}, ${params.invitedBy},
         ${params.tokenHash}, ${params.note}, ${params.expiresAt}, ${params.maxUses})
      RETURNING id, workspace_id, kind, email, role, invited_by, workos_invitation_id, token_hash, note,
        status, created_at, expires_at, accepted_at, revoked_at, parent_link_id, max_uses,
        accepted_workos_user_id, acceptance_consumes_capacity, revision, 0::int AS use_count
    `)
    return mapRow(result.rows[0])
  },

  async claimLegacyAdminLink(db: Querier, workspaceId: string, id: string, email: string): Promise<Invitation | null> {
    const result = await db.query<{ id: string }>(sql`
      UPDATE workspace_invitations
      SET email = ${email}
      WHERE id = ${id} AND workspace_id = ${workspaceId}
        AND kind = 'link'
        AND parent_link_id IS NULL
        AND role = 'admin'
        AND status = 'pending'
        AND email IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING id
    `)
    return result.rows[0] ? findById(db, result.rows[0].id) : null
  },

  async findLinkChild(
    db: Querier,
    workspaceId: string,
    parentLinkId: string,
    email: string
  ): Promise<Invitation | null> {
    const result = await db.query<{ id: string }>(sql`
      SELECT id FROM workspace_invitations
      WHERE workspace_id = ${workspaceId} AND parent_link_id = ${parentLinkId} AND lower(email) = lower(${email})
    `)
    return result.rows[0] ? findById(db, result.rows[0].id) : null
  },

  async countPendingLinkChildren(db: Querier, workspaceId: string, parentLinkId: string): Promise<number> {
    const result = await db.query<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM workspace_invitations
      WHERE workspace_id = ${workspaceId} AND parent_link_id = ${parentLinkId} AND status = 'pending'
    `)
    return Number(result.rows[0]?.count ?? 0)
  },

  async insertOrFindLinkChild(
    db: Querier,
    params: { id: string; parent: Invitation; email: string }
  ): Promise<Invitation> {
    const result = await db.query<{ id: string }>(sql`
      INSERT INTO workspace_invitations
        (id, workspace_id, kind, email, role, invited_by, expires_at, parent_link_id, max_uses)
      VALUES
        (${params.id}, ${params.parent.workspaceId}, 'link', ${params.email}, ${params.parent.role},
         ${params.parent.invitedBy}, ${params.parent.expiresAt}, ${params.parent.id}, NULL)
      ON CONFLICT (parent_link_id, lower(email)) WHERE parent_link_id IS NOT NULL
      DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `)
    return (await findById(db, result.rows[0].id))!
  },

  async findRootByTokenHashForUpdate(db: Querier, tokenHash: string): Promise<Invitation | null> {
    const result = await db.query<{ id: string }>(sql`
      SELECT id FROM workspace_invitations
      WHERE token_hash = ${tokenHash} AND kind = 'link' AND parent_link_id IS NULL
      FOR UPDATE
    `)
    return result.rows[0] ? findById(db, result.rows[0].id) : null
  },

  findById(db: Querier, id: string): Promise<Invitation | null> {
    return findById(db, id)
  },

  findByIdForUpdate(db: Querier, id: string): Promise<Invitation | null> {
    return findById(db, id, true)
  },

  async lockMembershipIdentity(db: Querier, workspaceId: string, workosUserId: string): Promise<void> {
    await db.query(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${workosUserId}`}, 0))`)
  },

  async listByWorkspace(
    db: Querier,
    workspaceId: string,
    filters?: { status?: InvitationStatus }
  ): Promise<Invitation[]> {
    const result = filters?.status
      ? await db.query<InvitationRow>(sql`
          SELECT ${sql.raw(SELECT_FIELDS)} FROM workspace_invitations wi
          WHERE wi.workspace_id = ${workspaceId} AND wi.parent_link_id IS NULL AND wi.status = ${filters.status}
          ORDER BY wi.created_at DESC
        `)
      : await db.query<InvitationRow>(sql`
          SELECT ${sql.raw(SELECT_FIELDS)} FROM workspace_invitations wi
          WHERE wi.workspace_id = ${workspaceId} AND wi.parent_link_id IS NULL
          ORDER BY wi.created_at DESC
        `)
    return result.rows.map(mapRow)
  },

  async findPendingByEmail(db: Querier, email: string): Promise<Invitation[]> {
    const result = await db.query<InvitationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM workspace_invitations wi
      LEFT JOIN workspace_invitations parent
        ON parent.id = wi.parent_link_id AND parent.workspace_id = wi.workspace_id
      WHERE wi.email = ${email} AND wi.status = 'pending'
        AND (CASE WHEN parent.id IS NULL THEN wi.status ELSE parent.status END) <> 'revoked'
        AND (CASE WHEN parent.id IS NULL THEN wi.expires_at ELSE parent.expires_at END IS NULL
          OR CASE WHEN parent.id IS NULL THEN wi.expires_at ELSE parent.expires_at END > NOW())
        AND ${sql.raw(PARENT_HAS_CAPACITY)}
      ORDER BY wi.created_at DESC
    `)
    return result.rows.map(mapRow)
  },

  async findPendingByEmailsAndWorkspace(db: Querier, emails: string[], workspaceId: string): Promise<Invitation[]> {
    if (emails.length === 0) return []
    const result = await db.query<InvitationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM workspace_invitations wi
      LEFT JOIN workspace_invitations parent
        ON parent.id = wi.parent_link_id AND parent.workspace_id = wi.workspace_id
      WHERE wi.email = ANY(${emails}) AND wi.workspace_id = ${workspaceId} AND wi.status = 'pending'
        AND (CASE WHEN parent.id IS NULL THEN wi.status ELSE parent.status END) <> 'revoked'
        AND (CASE WHEN parent.id IS NULL THEN wi.expires_at ELSE parent.expires_at END IS NULL
          OR CASE WHEN parent.id IS NULL THEN wi.expires_at ELSE parent.expires_at END > NOW())
        AND ${sql.raw(PARENT_HAS_CAPACITY)}
    `)
    return result.rows.map(mapRow)
  },

  async accept(
    db: Querier,
    id: string,
    acceptedAt: Date,
    acceptedWorkosUserId: string | null,
    consumesCapacity: boolean
  ): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE workspace_invitations
      SET status = 'accepted', accepted_at = ${acceptedAt}, accepted_workos_user_id = ${acceptedWorkosUserId},
          acceptance_consumes_capacity = ${consumesCapacity}
      WHERE id = ${id} AND status = 'pending'
    `)
    return (result.rowCount ?? 0) > 0
  },

  async incrementRevision(db: Querier, id: string): Promise<void> {
    await db.query(sql`
      UPDATE workspace_invitations SET revision = revision + 1 WHERE id = ${id}
    `)
  },

  async updateLink(
    db: Querier,
    id: string,
    workspaceId: string,
    params: { maxUses?: number | null; expiresAt?: Date | null }
  ): Promise<Invitation | null> {
    const current = await findById(db, id, true)
    if (
      !current ||
      current.workspaceId !== workspaceId ||
      current.kind !== "link" ||
      current.parentLinkId ||
      current.status === "revoked"
    ) {
      return null
    }
    if (current.role === "admin" && params.maxUses !== undefined && params.maxUses !== 1) return null
    const maxUses = params.maxUses === undefined ? current.maxUses : params.maxUses
    if (maxUses !== null && maxUses < current.useCount) return null
    const expiresAt = params.expiresAt === undefined ? current.expiresAt : params.expiresAt
    await db.query(sql`
      UPDATE workspace_invitations
      SET max_uses = ${maxUses}, expires_at = ${expiresAt}, revision = revision + 1,
          status = CASE WHEN status = 'expired' THEN 'pending' ELSE status END
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return findById(db, id)
  },

  async revoke(db: Querier, id: string, workspaceId: string, revokedAt: Date): Promise<Invitation | null> {
    const result = await db.query<{ id: string }>(sql`
      UPDATE workspace_invitations
      SET status = 'revoked', revoked_at = ${revokedAt}, revision = revision + 1
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND status <> 'revoked'
        AND (status = 'pending' OR (kind = 'link' AND parent_link_id IS NULL))
      RETURNING id
    `)
    return result.rows[0] ? findById(db, result.rows[0].id) : null
  },

  async markExpired(db: Querier, workspaceId: string): Promise<number> {
    const result = await db.query(sql`
      UPDATE workspace_invitations
      SET status = 'expired'
      WHERE workspace_id = ${workspaceId} AND kind = 'email' AND status = 'pending' AND expires_at < NOW()
    `)
    return result.rowCount ?? 0
  },
}
