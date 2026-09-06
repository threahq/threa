import type { Pool } from "pg"
import { createHash } from "node:crypto"
import {
  withTransaction,
  displayNameFromWorkos,
  getWorkosErrorCode,
  HttpError,
  logger,
  type WorkosOrgService,
} from "@threa/backend-common"
import { InvitationShadowRepository, type InvitationShadowRow } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import { RegionalInvitationError, type RegionalClient } from "../../lib/regional-client"
import type { InvitationLinkLookupResponse, PendingInvitation, WorkspaceInvitableRole } from "@threa/types"
// Type-only to avoid a runtime module cycle; injected by the composition root.
import type { PlatformAdminSyncService } from "../platform-admin"

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

const INVITATION_ERROR_MESSAGES = {
  INVITATION_NOT_FOUND: "Invitation not found",
  INVITATION_REVOKED: "This invitation has been revoked",
  INVITATION_EXPIRED: "This invitation has expired",
  INVITATION_EXHAUSTED: "This invite link has reached its join limit",
  INVITATION_ALREADY_CLAIMED: "This invite link has already been used",
  INVITATION_ACCEPTANCE_CONFLICT: "Invitation changed while accepting; try again",
  INVITATION_PARENT_CONFLICT: "Invitation link changed while accepting; try again",
  INVITATION_SHADOW_NOT_READY: "Invitations are temporarily unavailable; try again shortly",
  INVITATION_ROLLOUT_UNAVAILABLE: "Invitations are temporarily unavailable; try again shortly",
} as const

function invitationErrorMessage(code: string | null | undefined, fallback: string): string {
  if (code && code in INVITATION_ERROR_MESSAGES) {
    return INVITATION_ERROR_MESSAGES[code as keyof typeof INVITATION_ERROR_MESSAGES]
  }
  return fallback
}

const WORKOS_ERROR_CODES = {
  USER_ALREADY_MEMBER: "user_already_organization_member",
  EMAIL_ALREADY_INVITED: "email_already_invited_to_organization",
  INVITE_NOT_PENDING: "invite_not_pending",
} as const

/** User info for shadow acceptance — accepts either pre-derived name (stub) or WorkOS fields */
type ShadowUser =
  | { id: string; email: string; name: string }
  | { id: string; email: string; firstName?: string | null; lastName?: string | null }

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
  workosOrgService: WorkosOrgService
  platformAdminSync: PlatformAdminSyncService
}

export class InvitationShadowService {
  private pool: Pool
  private regionalClient: RegionalClient
  private workosOrgService: WorkosOrgService
  private platformAdminSync: PlatformAdminSyncService

  constructor({ pool, regionalClient, workosOrgService, platformAdminSync }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
    this.workosOrgService = workosOrgService
    this.platformAdminSync = platformAdminSync
  }

  private resolveDisplayName(user: ShadowUser): string {
    if ("name" in user && user.name) return user.name
    return displayNameFromWorkos(user)
  }

  /** List pending invitations for a user email, including workspace names */
  async listPendingForEmail(email: string): Promise<PendingInvitation[]> {
    const rows = await InvitationShadowRepository.findPendingByEmailWithWorkspace(this.pool, email)
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      expiresAt: row.expires_at?.toISOString() ?? null,
    }))
  }

  /** Accept a single shadow invitation on behalf of a user */
  async acceptShadow(shadowId: string, user: ShadowUser): Promise<{ workspaceId: string }> {
    const shadow = await InvitationShadowRepository.findById(this.pool, shadowId)
    if (!shadow || !shadow.email || shadow.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new HttpError("Invitation not found", { status: 404, code: "NOT_FOUND" })
    }

    const alreadyMember = await WorkspaceRegistryRepository.isMember(this.pool, shadow.workspace_id, user.id)
    let insertedMembership = false
    if (!alreadyMember || shadow.status === "pending") {
      const name = this.resolveDisplayName(user)
      try {
        await this.regionalClient.acceptInvitation(shadow.region, shadow.id, {
          workosUserId: user.id,
          email: user.email,
          name,
        })
      } catch (error) {
        if (error instanceof RegionalInvitationError) {
          const code = error.upstreamCode()
          throw new HttpError(invitationErrorMessage(code, "Invitation acceptance failed"), {
            status: error.status,
            code: code ?? undefined,
          })
        }
        throw error
      }

      insertedMembership = await withTransaction(this.pool, async (client) => {
        const accepted = await InvitationShadowRepository.recordAccepted(client, {
          id: shadow.id,
          workspaceId: shadow.workspace_id,
          email: user.email,
          workosUserId: user.id,
          preserveRevokedStatus: shadow.kind === "link" && shadow.parent_link_id === null,
        })
        if (!accepted) throw new Error("Invitation shadow changed during regional acceptance")
        const inserted = await WorkspaceRegistryRepository.insertMembership(client, shadow.workspace_id, user.id)
        await this.platformAdminSync.enqueueIfAdmin(client, user.id)
        return inserted
      })
    }

    if (insertedMembership) await this.syncWorkosMembership(shadow.workspace_id, user.id, shadow.role_slug)
    return { workspaceId: shadow.workspace_id }
  }

  async reconcileAccepted(params: {
    id: string
    workspaceId: string
    email: string
    workosUserId: string
    parentInvitationId?: string
    expiresAt?: Date | null
    maxUses?: number | null
    useCount?: number
    revision?: number
    status?: "pending" | "accepted" | "expired" | "revoked"
  }): Promise<void> {
    const result = await withTransaction(this.pool, async (client) => {
      let parent: InvitationShadowRow | null = null
      if (params.parentInvitationId) {
        parent = await InvitationShadowRepository.findByIdForUpdate(client, params.parentInvitationId)
        if (!parent) {
          throw new HttpError(`Invitation parent shadow ${params.parentInvitationId} is not mirrored yet`, {
            status: 503,
            code: "INVITATION_SHADOW_NOT_READY",
          })
        }
        if (parent.workspace_id !== params.workspaceId || parent.kind !== "link" || parent.parent_link_id) {
          throw new HttpError(`Invitation parent shadow ${params.parentInvitationId} conflicts`, {
            status: 409,
            code: "INVITATION_PARENT_CONFLICT",
          })
        }
      }

      let invitation =
        params.id === params.parentInvitationId
          ? parent
          : await InvitationShadowRepository.findByIdForUpdate(client, params.id)
      let preserveRevokedStatus = false
      let revokedChildren: InvitationShadowRow[] = []

      if (parent) {
        let currentParent = parent
        if (
          params.expiresAt !== undefined &&
          params.maxUses !== undefined &&
          params.useCount !== undefined &&
          params.revision !== undefined &&
          params.status !== undefined
        ) {
          currentParent =
            (await InvitationShadowRepository.applyParentSnapshot(client, parent.id, {
              expiresAt: params.expiresAt,
              maxUses: params.maxUses,
              useCount: params.useCount,
              revision: params.revision,
              status: params.status,
            })) ?? parent
        }
        if (currentParent.status === "revoked") {
          revokedChildren = await InvitationShadowRepository.revokePendingChildren(client, parent.id)
        }
        if (!invitation && params.id !== parent.id) {
          invitation = await InvitationShadowRepository.insertLinkChild(client, {
            id: params.id,
            parent: currentParent,
            email: params.email,
          })
        }
        if (params.id === parent.id) {
          invitation = await InvitationShadowRepository.setEmailFromLegacyClaim(client, parent.id, params.email)
          if (!invitation) {
            throw new HttpError(`Invitation shadow ${params.id} acceptance identity conflicts`, {
              status: 409,
              code: "INVITATION_ACCEPTANCE_CONFLICT",
            })
          }
          preserveRevokedStatus = true
        }
      }

      if (!invitation) {
        throw new HttpError(`Invitation shadow ${params.id} is not mirrored yet`, {
          status: 503,
          code: "INVITATION_SHADOW_NOT_READY",
        })
      }
      if (
        invitation.parent_link_id !==
        (params.parentInvitationId && params.parentInvitationId !== params.id ? params.parentInvitationId : null)
      ) {
        throw new HttpError(`Invitation shadow ${params.id} has an unexpected parent`, {
          status: 409,
          code: "INVITATION_PARENT_CONFLICT",
        })
      }
      const recorded = await InvitationShadowRepository.recordAccepted(client, {
        id: params.id,
        workspaceId: params.workspaceId,
        email: params.email,
        workosUserId: params.workosUserId,
        preserveRevokedStatus,
      })
      if (!recorded) {
        throw new HttpError(`Invitation shadow ${params.id} acceptance identity conflicts`, {
          status: 409,
          code: "INVITATION_ACCEPTANCE_CONFLICT",
        })
      }
      const insertedMembership = await WorkspaceRegistryRepository.insertMembership(
        client,
        params.workspaceId,
        params.workosUserId
      )
      await this.platformAdminSync.enqueueIfAdmin(client, params.workosUserId)
      return { recorded, revokedChildren, insertedMembership }
    })

    for (const child of result.revokedChildren) {
      if (child.workos_invitation_id) await this.revokeWorkosInvitation(child.id, child.workos_invitation_id)
    }
    if (result.insertedMembership) {
      await this.syncWorkosMembership(params.workspaceId, params.workosUserId, result.recorded.role_slug)
    }
  }

  /**
   * Create an invitation shadow. For email invites, also send the WorkOS
   * invitation email. For link invites, the shadow is created with no email
   * yet — WorkOS isn't contacted until the recipient claims the link.
   * WorkOS state conflicts (already invited, already member) are logged as warnings.
   */
  async createShadow(params: {
    id: string
    workspaceId: string
    region: string
    kind: "email" | "link"
    email: string | null
    tokenHash: string | null
    roleSlug: WorkspaceInvitableRole
    expiresAt: Date | null
    maxUses?: number | null
    useCount?: number
    revision?: number
    status?: "pending" | "accepted" | "expired" | "revoked"
    inviterWorkosUserId?: string
  }) {
    let maxUses = params.maxUses
    if (maxUses === undefined) maxUses = params.kind === "link" ? 1 : null
    const shadow = await InvitationShadowRepository.insert(this.pool, {
      ...params,
      maxUses,
      useCount: params.useCount ?? (params.status === "accepted" ? 1 : 0),
      revision: params.revision ?? 0,
      status: params.status ?? "pending",
    })

    // Link invites have no email at creation — defer WorkOS until claim.
    if (params.kind === "link" || !params.email) {
      return shadow
    }

    const orgId = await this.ensureWorkosOrganization(params.workspaceId)

    // No DB connection held during the WorkOS send (INV-41).
    if (orgId && params.inviterWorkosUserId) {
      await this.sendWorkosInvitationForShadow({
        shadowId: shadow.id,
        email: params.email,
        organizationId: orgId,
        inviterWorkosUserId: params.inviterWorkosUserId,
        roleSlug: shadow.role_slug,
        expectedWorkosInvitationId: shadow.workos_invitation_id,
        workosInvitationExpiresAt: shadow.workos_invitation_expires_at,
      })
    }

    return shadow
  }

  /**
   * Resolve a public-surface link token. Returns workspace name + expiry only —
   * never the email, role, note, or inviter identity.
   */
  async lookupByToken(token: string): Promise<InvitationLinkLookupResponse> {
    const tokenHash = hashToken(token)
    const row = await InvitationShadowRepository.findByTokenHashWithWorkspace(this.pool, tokenHash)
    if (!row) {
      throw new HttpError("Invitation not found", { status: 404, code: "INVITATION_NOT_FOUND" })
    }
    if (row.status === "revoked") {
      throw new HttpError("Invitation revoked", { status: 409, code: "INVITATION_REVOKED" })
    }
    if (row.revision === 0 && row.status === "accepted") {
      throw new HttpError("Invitation already used", { status: 409, code: "INVITATION_ALREADY_CLAIMED" })
    }
    if (row.expires_at && row.expires_at <= new Date()) {
      throw new HttpError("Invitation expired", { status: 409, code: "INVITATION_EXPIRED" })
    }
    if (row.max_uses !== null && row.use_count >= row.max_uses) {
      throw new HttpError("Invitation exhausted", { status: 409, code: "INVITATION_EXHAUSTED" })
    }

    return {
      workspaceName: row.workspace_name,
      expiresAt: row.expires_at?.toISOString() ?? null,
    }
  }

  /**
   * Public-surface claim. The token-hash lookup happens on CP (so the public
   * call doesn't have to leak which region owns the row), then forwards to
   * the regional backend for the atomic single-use claim. Regional emits an
   * outbox event that loops back to `acceptLinkClaim` below to drive WorkOS.
   */
  async claimByToken(token: string, email: string): Promise<{ ok: true; alreadyMember?: { workspaceId: string } }> {
    const tokenHash = hashToken(token)
    const shadow = await InvitationShadowRepository.findByTokenHashWithWorkspace(this.pool, tokenHash)
    if (!shadow) {
      throw new HttpError("Invitation not found", { status: 404, code: "INVITATION_NOT_FOUND" })
    }
    if (shadow.revision === 0 && shadow.status === "accepted") {
      throw new HttpError("Invitation already used", { status: 409, code: "INVITATION_ALREADY_CLAIMED" })
    }

    // Look up region from full shadow row (the workspace-joined row drops region)
    const fullShadow = await InvitationShadowRepository.findById(this.pool, shadow.id)
    if (!fullShadow) {
      throw new HttpError("Invitation not found", { status: 404, code: "INVITATION_NOT_FOUND" })
    }

    try {
      const claim = await this.regionalClient.claimInvitationLink(fullShadow.region, { token, email })
      return claim.alreadyMember ? { ok: true, alreadyMember: claim.alreadyMember } : { ok: true }
    } catch (err) {
      if (err instanceof RegionalInvitationError) {
        const code = err.upstreamCode()
        if (
          code === "INVITATION_REVOKED" ||
          code === "INVITATION_EXPIRED" ||
          code === "INVITATION_EXHAUSTED" ||
          code === "INVITATION_CLAIM_LIMIT" ||
          code === "INVITATION_ALREADY_CLAIMED"
        ) {
          throw new HttpError(invitationErrorMessage(code, "Invitation claim failed"), { status: 409, code })
        }
        if (code === "INVITATION_NOT_FOUND") {
          throw new HttpError(invitationErrorMessage(code, "Invitation claim failed"), { status: 404, code })
        }
        if (code === "INVITATION_ROLLOUT_UNAVAILABLE") {
          throw new HttpError(invitationErrorMessage(code, "Invitation claim failed"), { status: 503, code })
        }
      }
      throw err
    }
  }

  /**
   * Inbound shadow-sync: regional has bound an email to a previously-unclaimed
   * link invitation. Mirror the email locally, then trigger the WorkOS
   * invitation so the recipient gets a verification email. Idempotent.
   */
  async acceptLinkClaim(params: {
    id: string
    childInvitationId?: string
    email: string
    expiresAt?: Date | null
    maxUses?: number | null
    useCount?: number
    revision?: number
    inviterWorkosUserId?: string
  }): Promise<void> {
    const updated = await withTransaction(this.pool, async (client) => {
      const parent = await InvitationShadowRepository.findByIdForUpdate(client, params.id)
      if (!parent || parent.kind !== "link" || parent.parent_link_id) return null

      if (!params.childInvitationId) {
        return InvitationShadowRepository.setEmailFromLegacyClaim(client, params.id, params.email)
      }

      if (params.revision !== undefined && params.useCount !== undefined && params.maxUses !== undefined) {
        await InvitationShadowRepository.applyParentSnapshot(client, params.id, {
          expiresAt: params.expiresAt ?? null,
          maxUses: params.maxUses,
          useCount: params.useCount,
          revision: params.revision,
          status: parent.status as "pending" | "accepted" | "expired" | "revoked",
        })
      }
      const currentParent = (await InvitationShadowRepository.findById(client, params.id)) ?? parent
      return InvitationShadowRepository.insertLinkChild(client, {
        id: params.childInvitationId,
        parent: currentParent,
        email: params.email,
        inviterWorkosUserId: params.inviterWorkosUserId,
      })
    })

    if (!updated) {
      logger.warn({ id: params.id }, "Link claim received for unknown parent shadow")
      return
    }
    if (updated.status !== "pending") return

    const orgId = await this.ensureWorkosOrganization(updated.workspace_id)
    if (!orgId || !params.inviterWorkosUserId) {
      logger.warn(
        { id: params.id, hasOrg: !!orgId, hasInviter: !!params.inviterWorkosUserId },
        "Skipping WorkOS invite for link claim — missing org or inviter"
      )
      return
    }

    await this.sendWorkosInvitationForShadow({
      shadowId: updated.id,
      email: params.email,
      organizationId: orgId,
      inviterWorkosUserId: params.inviterWorkosUserId,
      roleSlug: updated.role_slug,
      expectedWorkosInvitationId: updated.workos_invitation_id,
      workosInvitationExpiresAt: updated.workos_invitation_expires_at,
    })
  }

  private async sendWorkosInvitationForShadow(params: {
    shadowId: string
    email: string
    organizationId: string
    inviterWorkosUserId: string
    roleSlug: WorkspaceInvitableRole
    expectedWorkosInvitationId: string | null
    workosInvitationExpiresAt: Date | null
  }): Promise<void> {
    try {
      if (params.workosInvitationExpiresAt && params.workosInvitationExpiresAt > new Date()) return

      let workosInvitation: { id: string; expiresAt: Date }
      if (params.expectedWorkosInvitationId) {
        const existing = await this.workosOrgService.getInvitation(params.expectedWorkosInvitationId)
        if (existing.state === "accepted") return
        if (existing.state === "pending" && existing.expiresAt > new Date()) {
          await InvitationShadowRepository.storeWorkosInvitation(this.pool, {
            id: params.shadowId,
            expectedWorkosInvitationId: params.expectedWorkosInvitationId,
            workosInvitationId: existing.id,
            workosInvitationExpiresAt: existing.expiresAt,
          })
          return
        }
        workosInvitation =
          existing.state === "pending"
            ? await this.workosOrgService.resendInvitation(existing.id)
            : await this.workosOrgService.sendInvitation({
                organizationId: params.organizationId,
                email: params.email,
                inviterUserId: params.inviterWorkosUserId,
                roleSlug: params.roleSlug,
              })
      } else {
        workosInvitation = await this.workosOrgService.sendInvitation({
          organizationId: params.organizationId,
          email: params.email,
          inviterUserId: params.inviterWorkosUserId,
          roleSlug: params.roleSlug,
        })
      }

      let stored: boolean
      try {
        stored = await InvitationShadowRepository.storeWorkosInvitation(this.pool, {
          id: params.shadowId,
          expectedWorkosInvitationId: params.expectedWorkosInvitationId,
          workosInvitationId: workosInvitation.id,
          workosInvitationExpiresAt: workosInvitation.expiresAt,
        })
      } catch (error) {
        await this.revokeWorkosInvitation(params.shadowId, workosInvitation.id)
        throw error
      }
      if (!stored) await this.revokeWorkosInvitation(params.shadowId, workosInvitation.id)
    } catch (error) {
      const errorCode = getWorkosErrorCode(error)
      const isKnownStateConflict =
        errorCode === WORKOS_ERROR_CODES.USER_ALREADY_MEMBER || errorCode === WORKOS_ERROR_CODES.EMAIL_ALREADY_INVITED

      if (isKnownStateConflict) {
        logger.warn(
          { errorCode, email: params.email, shadowId: params.shadowId },
          "WorkOS state conflict when sending invitation (noop)"
        )
      } else {
        logger.error({ err: error, email: params.email, shadowId: params.shadowId }, "Failed to send WorkOS invitation")
        throw error
      }
    }
  }

  /**
   * Update shadow status. When revoking, also revoke the WorkOS invitation
   * if one was sent. Uses atomic claim to prevent accept/revoke races (INV-20).
   */
  async updateStatus(id: string, status: "accepted" | "revoked") {
    const result = await withTransaction(this.pool, async (client) => {
      const claimed = await InvitationShadowRepository.claimPending(client, id, status)
      if (!claimed) return null
      const revokedChildren =
        status === "revoked" && claimed.kind === "link" && claimed.parent_link_id === null
          ? await InvitationShadowRepository.revokePendingChildren(client, id)
          : []
      return { claimed, revokedChildren }
    })
    if (!result) return false

    if (status === "revoked" && result.claimed.workos_invitation_id) {
      await this.revokeWorkosInvitation(id, result.claimed.workos_invitation_id)
    }
    for (const child of result.revokedChildren) {
      if (child.workos_invitation_id) await this.revokeWorkosInvitation(child.id, child.workos_invitation_id)
    }

    return true
  }

  private async syncWorkosMembership(
    workspaceId: string,
    workosUserId: string,
    roleSlug: WorkspaceInvitableRole
  ): Promise<void> {
    const orgId = await this.ensureWorkosOrganization(workspaceId)
    if (!orgId) return
    try {
      await this.workosOrgService.ensureOrganizationMembership({
        organizationId: orgId,
        userId: workosUserId,
        roleSlug,
      })
    } catch (error) {
      logger.warn({ err: error, workspaceId }, "Failed to sync WorkOS org membership on accept")
    }
  }

  private async revokeWorkosInvitation(shadowId: string, workosInvitationId: string): Promise<void> {
    try {
      await this.workosOrgService.revokeInvitation(workosInvitationId)
    } catch (error) {
      const errorCode = getWorkosErrorCode(error)
      if (errorCode === WORKOS_ERROR_CODES.INVITE_NOT_PENDING) {
        logger.warn({ errorCode, shadowId }, "WorkOS state conflict when revoking invitation (noop)")
      } else {
        logger.error({ err: error, shadowId }, "Failed to revoke WorkOS invitation")
      }
    }
  }

  async updateLinkSnapshot(
    id: string,
    snapshot: {
      expiresAt: Date | null
      maxUses: number | null
      useCount: number
      revision: number
      status: "pending" | "accepted" | "expired" | "revoked"
    }
  ): Promise<boolean> {
    const result = await withTransaction(this.pool, async (client) => {
      const parent = await InvitationShadowRepository.findByIdForUpdate(client, id)
      if (!parent || parent.kind !== "link" || parent.parent_link_id) return null
      const updated = await InvitationShadowRepository.applyParentSnapshot(client, id, snapshot)
      if (!updated) return null
      const revokedChildren =
        updated.status === "revoked" ? await InvitationShadowRepository.revokePendingChildren(client, id) : []
      return { updated, revokedChildren }
    })
    if (!result) return false

    for (const child of result.revokedChildren) {
      if (child.workos_invitation_id) await this.revokeWorkosInvitation(child.id, child.workos_invitation_id)
    }
    return true
  }

  /**
   * Ensure a WorkOS organization exists for the given workspace.
   * Uses 3-tier lookup: local cache → WorkOS by external ID → create new.
   * No DB connection is held during WorkOS API calls (INV-41).
   */
  private async ensureWorkosOrganization(workspaceId: string): Promise<string | null> {
    // Tier 1: Check local DB cache
    const cachedOrgId = await WorkspaceRegistryRepository.getWorkosOrganizationId(this.pool, workspaceId)
    if (cachedOrgId) return cachedOrgId

    // Tier 2: Check WorkOS by external ID — survives local DB wipes
    const existingOrg = await this.workosOrgService.getOrganizationByExternalId(workspaceId)
    if (existingOrg) {
      await WorkspaceRegistryRepository.setWorkosOrganizationId(this.pool, workspaceId, existingOrg.id)
      return existingOrg.id
    }

    // Tier 3: Create new org in WorkOS
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, workspaceId)
    if (!workspace) return null

    try {
      const org = await this.workosOrgService.createOrganization({
        name: workspace.name,
        externalId: workspaceId,
      })
      // Optimistic guard: WHERE workos_organization_id IS NULL
      // Concurrent losers no-op (INV-20)
      await WorkspaceRegistryRepository.setWorkosOrganizationId(this.pool, workspaceId, org.id)
    } catch (error) {
      logger.error({ err: error, workspaceId }, "Failed to create WorkOS organization")
    }

    // Re-read to get the winning org ID (handles concurrent creation race)
    return WorkspaceRegistryRepository.getWorkosOrganizationId(this.pool, workspaceId)
  }
}
