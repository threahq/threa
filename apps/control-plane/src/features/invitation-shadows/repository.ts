import type { Querier } from "@threahq/backend-common"
import type { InvitationStatus, WorkspaceInvitableRole } from "@threahq/types"

export interface InvitationShadowRow {
  id: string
  workspace_id: string
  kind: string
  email: string | null
  region: string
  status: string
  workos_invitation_id: string | null
  workos_invitation_expires_at: Date | null
  inviter_workos_user_id: string | null
  token_hash: string | null
  role_slug: WorkspaceInvitableRole
  parent_link_id: string | null
  max_uses: number | null
  use_count: number
  revision: number
  accepted_workos_user_id: string | null
  created_at: Date
  expires_at: Date | null
}

export interface PendingInvitationRow {
  id: string
  workspace_id: string
  workspace_name: string
  expires_at: Date | null
}

export interface LinkLookupRow {
  id: string
  workspace_id: string
  workspace_name: string
  status: string
  expires_at: Date | null
  max_uses: number | null
  use_count: number
  revision: number
}

const SELECT_FIELDS = `id, workspace_id, kind, email, region, status, workos_invitation_id, workos_invitation_expires_at, inviter_workos_user_id, token_hash, role_slug, parent_link_id, max_uses, use_count, revision, accepted_workos_user_id, created_at, expires_at`
const SELECT_FIELDS_S = `s.id, s.workspace_id, s.kind, s.email, s.region, s.status, s.workos_invitation_id, s.workos_invitation_expires_at, s.inviter_workos_user_id, s.token_hash, s.role_slug, s.parent_link_id, s.max_uses, s.use_count, s.revision, s.accepted_workos_user_id, s.created_at, s.expires_at`

export const InvitationShadowRepository = {
  async findById(db: Querier, id: string): Promise<InvitationShadowRow | null> {
    const result = await db.query<InvitationShadowRow>(
      `SELECT ${SELECT_FIELDS} FROM invitation_shadows WHERE id = $1`,
      [id]
    )
    return result.rows[0] ?? null
  },

  async findByIdForUpdate(db: Querier, id: string): Promise<InvitationShadowRow | null> {
    const result = await db.query<InvitationShadowRow>(
      `SELECT ${SELECT_FIELDS} FROM invitation_shadows WHERE id = $1 FOR UPDATE`,
      [id]
    )
    return result.rows[0] ?? null
  },

  async listPendingByWorkspace(db: Querier, workspaceId: string): Promise<InvitationShadowRow[]> {
    const result = await db.query<InvitationShadowRow>(
      `SELECT ${SELECT_FIELDS_S} FROM invitation_shadows s
       LEFT JOIN invitation_shadows p ON p.id = s.parent_link_id
       WHERE s.workspace_id = $1 AND s.status = 'pending'
         AND (CASE WHEN p.id IS NULL THEN s.expires_at ELSE p.expires_at END IS NULL
              OR CASE WHEN p.id IS NULL THEN s.expires_at ELSE p.expires_at END > NOW())
       ORDER BY s.created_at DESC`,
      [workspaceId]
    )
    return result.rows
  },

  async findPendingByEmailWithWorkspace(db: Querier, email: string): Promise<PendingInvitationRow[]> {
    const result = await db.query<PendingInvitationRow>(
      `SELECT s.id, s.workspace_id, wr.name AS workspace_name,
              CASE WHEN p.id IS NULL THEN s.expires_at ELSE p.expires_at END AS expires_at
       FROM invitation_shadows s
       JOIN workspace_registry wr ON wr.id = s.workspace_id
       LEFT JOIN invitation_shadows p ON p.id = s.parent_link_id
       WHERE s.email = $1 AND s.status = 'pending'
         AND (p.id IS NULL OR p.status <> 'revoked')
         AND (CASE WHEN p.id IS NULL THEN s.expires_at ELSE p.expires_at END IS NULL
              OR CASE WHEN p.id IS NULL THEN s.expires_at ELSE p.expires_at END > NOW())
         AND (p.id IS NULL OR p.max_uses IS NULL OR p.use_count < p.max_uses)
       ORDER BY s.created_at DESC`,
      [email.toLowerCase()]
    )
    return result.rows
  },

  async insert(
    db: Querier,
    shadow: {
      id: string
      workspaceId: string
      region: string
      kind: "email" | "link"
      email: string | null
      tokenHash: string | null
      roleSlug: WorkspaceInvitableRole
      expiresAt: Date | null
      maxUses: number | null
      useCount: number
      revision: number
      status: InvitationStatus
      inviterWorkosUserId?: string
    }
  ): Promise<InvitationShadowRow> {
    const result = await db.query<InvitationShadowRow>(
      `INSERT INTO invitation_shadows
         (id, workspace_id, kind, email, region, expires_at, inviter_workos_user_id, token_hash, role_slug,
          max_uses, use_count, revision, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         expires_at = CASE WHEN invitation_shadows.status = 'revoked' THEN invitation_shadows.expires_at ELSE EXCLUDED.expires_at END,
         max_uses = CASE WHEN invitation_shadows.status = 'revoked' THEN invitation_shadows.max_uses ELSE EXCLUDED.max_uses END,
         use_count = CASE WHEN invitation_shadows.status = 'revoked' THEN invitation_shadows.use_count ELSE EXCLUDED.use_count END,
         revision = GREATEST(invitation_shadows.revision, EXCLUDED.revision),
         status = CASE
           WHEN invitation_shadows.status = 'revoked' THEN 'revoked'
           WHEN EXCLUDED.revision = 0 THEN invitation_shadows.status
           ELSE EXCLUDED.status
         END,
         inviter_workos_user_id = COALESCE(EXCLUDED.inviter_workos_user_id, invitation_shadows.inviter_workos_user_id)
       WHERE EXCLUDED.revision >= invitation_shadows.revision
       RETURNING ${SELECT_FIELDS}`,
      [
        shadow.id,
        shadow.workspaceId,
        shadow.kind,
        shadow.email ? shadow.email.toLowerCase() : null,
        shadow.region,
        shadow.expiresAt,
        shadow.inviterWorkosUserId ?? null,
        shadow.tokenHash,
        shadow.roleSlug,
        shadow.maxUses,
        shadow.useCount,
        shadow.revision,
        shadow.status,
      ]
    )
    if (result.rows[0]) return result.rows[0]
    const existing = await this.findById(db, shadow.id)
    if (!existing) throw new Error(`Invitation shadow ${shadow.id} disappeared during upsert`)
    return existing
  },

  async insertLinkChild(
    db: Querier,
    params: { id: string; parent: InvitationShadowRow; email: string; inviterWorkosUserId?: string }
  ): Promise<InvitationShadowRow> {
    const result = await db.query<InvitationShadowRow>(
      `INSERT INTO invitation_shadows
         (id, workspace_id, kind, email, region, expires_at, inviter_workos_user_id, token_hash, role_slug,
          parent_link_id, max_uses, use_count, revision, status)
       VALUES ($1, $2, 'link', $3, $4, $5, $6, NULL, $7, $8, NULL, 0, 0,
               CASE WHEN $9 = 'revoked' THEN 'revoked' ELSE 'pending' END)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${SELECT_FIELDS}`,
      [
        params.id,
        params.parent.workspace_id,
        params.email.toLowerCase(),
        params.parent.region,
        params.parent.expires_at,
        params.inviterWorkosUserId ?? params.parent.inviter_workos_user_id,
        params.parent.role_slug,
        params.parent.id,
        params.parent.status,
      ]
    )
    if (result.rows[0]) return result.rows[0]
    const existing = await this.findById(db, params.id)
    if (!existing) throw new Error(`Invitation child shadow ${params.id} disappeared during insert`)
    if (
      existing.parent_link_id !== params.parent.id ||
      existing.workspace_id !== params.parent.workspace_id ||
      existing.email?.toLowerCase() !== params.email.toLowerCase()
    ) {
      throw new Error(`Invitation child shadow ${params.id} conflicts with its parent or email`)
    }
    return existing
  },

  async applyParentSnapshot(
    db: Querier,
    id: string,
    snapshot: {
      expiresAt: Date | null
      maxUses: number | null
      useCount: number
      revision: number
      status: InvitationStatus
    }
  ): Promise<InvitationShadowRow | null> {
    const result = await db.query<InvitationShadowRow>(
      `UPDATE invitation_shadows
       SET expires_at = $2, max_uses = $3, use_count = $4, revision = $5,
           status = CASE WHEN status = 'revoked' THEN 'revoked' ELSE $6 END
       WHERE id = $1 AND kind = 'link' AND parent_link_id IS NULL AND $5 >= revision
       RETURNING ${SELECT_FIELDS}`,
      [id, snapshot.expiresAt, snapshot.maxUses, snapshot.useCount, snapshot.revision, snapshot.status]
    )
    if (result.rows[0]) return result.rows[0]
    const existing = await this.findById(db, id)
    return existing?.kind === "link" && existing.parent_link_id === null ? existing : null
  },

  async findByTokenHashWithWorkspace(db: Querier, tokenHash: string): Promise<LinkLookupRow | null> {
    const result = await db.query<LinkLookupRow>(
      `SELECT s.id, s.workspace_id, wr.name AS workspace_name, s.status, s.expires_at, s.max_uses, s.use_count, s.revision
       FROM invitation_shadows s
       JOIN workspace_registry wr ON wr.id = s.workspace_id
       WHERE s.token_hash = $1 AND s.kind = 'link' AND s.parent_link_id IS NULL
       LIMIT 1`,
      [tokenHash]
    )
    return result.rows[0] ?? null
  },

  async setEmailFromLegacyClaim(db: Querier, id: string, email: string): Promise<InvitationShadowRow | null> {
    const normalizedEmail = email.toLowerCase()
    const result = await db.query<InvitationShadowRow>(
      `UPDATE invitation_shadows SET email = $1
       WHERE id = $2 AND kind = 'link' AND parent_link_id IS NULL
         AND (email IS NULL OR lower(email) = $1)
       RETURNING ${SELECT_FIELDS}`,
      [normalizedEmail, id]
    )
    if (result.rows[0]) return result.rows[0]
    const existing = await this.findById(db, id)
    return existing?.kind === "link" &&
      existing.parent_link_id === null &&
      existing.email?.toLowerCase() === normalizedEmail
      ? existing
      : null
  },

  async storeWorkosInvitation(
    db: Querier,
    params: {
      id: string
      expectedWorkosInvitationId: string | null
      workosInvitationId: string
      workosInvitationExpiresAt: Date
    }
  ): Promise<boolean> {
    const result = await db.query(
      `UPDATE invitation_shadows
       SET workos_invitation_id = $3, workos_invitation_expires_at = $4
       WHERE id = $1 AND status = 'pending' AND workos_invitation_id IS NOT DISTINCT FROM $2`,
      [params.id, params.expectedWorkosInvitationId, params.workosInvitationId, params.workosInvitationExpiresAt]
    )
    return (result.rowCount ?? 0) > 0
  },

  async revokePendingChildren(db: Querier, parentId: string): Promise<InvitationShadowRow[]> {
    const result = await db.query<InvitationShadowRow>(
      `UPDATE invitation_shadows SET status = 'revoked'
       WHERE parent_link_id = $1 AND status = 'pending'
       RETURNING ${SELECT_FIELDS}`,
      [parentId]
    )
    return result.rows
  },

  async recordAccepted(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      email: string
      workosUserId: string
      preserveRevokedStatus: boolean
    }
  ): Promise<InvitationShadowRow | null> {
    const result = await db.query<InvitationShadowRow>(
      `UPDATE invitation_shadows
       SET status = CASE WHEN $5 AND status = 'revoked' THEN status ELSE 'accepted' END,
           accepted_workos_user_id = $4
       WHERE id = $1 AND workspace_id = $2 AND lower(email) = lower($3)
         AND (accepted_workos_user_id IS NULL OR accepted_workos_user_id = $4)
       RETURNING ${SELECT_FIELDS}`,
      [params.id, params.workspaceId, params.email, params.workosUserId, params.preserveRevokedStatus]
    )
    return result.rows[0] ?? null
  },

  async claimPending(db: Querier, id: string, status: "accepted" | "revoked"): Promise<InvitationShadowRow | null> {
    const result = await db.query<InvitationShadowRow>(
      `UPDATE invitation_shadows SET status = $1
       WHERE id = $2 AND status = 'pending'
       RETURNING ${SELECT_FIELDS}`,
      [status, id]
    )
    return result.rows[0] ?? null
  },
}
