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
import { InvitationShadowRepository } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import { RegionalClaimError, type RegionalClient } from "../../lib/regional-client"
import type { InvitationLinkLookupResponse, PendingInvitation, WorkspaceInvitableRole } from "@threa/types"
// Type-only to avoid a runtime module cycle; injected by the composition root.
import type { PlatformAdminSyncService } from "../platform-admin"

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
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
      expiresAt: row.expires_at.toISOString(),
    }))
  }

  /** Accept a single shadow invitation on behalf of a user */
  async acceptShadow(shadowId: string, user: ShadowUser): Promise<{ workspaceId: string }> {
    // Validate shadow exists and belongs to this user (read-only check)
    const shadow = await InvitationShadowRepository.findById(this.pool, shadowId)
    if (!shadow) {
      throw new HttpError("Invitation not found", { status: 404, code: "NOT_FOUND" })
    }
    // Email is null for unclaimed link invites — those can't be accepted via
    // this surface (they require the public claim flow first to bind an email).
    if (!shadow.email || shadow.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new HttpError("Invitation not found", { status: 404, code: "NOT_FOUND" })
    }

    // Early return for already-terminal states before opening a transaction.
    if (shadow.status === "accepted") {
      return { workspaceId: shadow.workspace_id }
    }
    if (shadow.status !== "pending") {
      throw new HttpError("Invitation is no longer available", { status: 409, code: "INVITATION_REVOKED" })
    }

    // Single transaction: claim → regional call → membership insert.
    // The regional call is a fast localhost hop, so holding the connection is acceptable.
    // On any failure the transaction auto-rollbacks — shadow stays pending, no revert needed.
    const result = await withTransaction(this.pool, async (client) => {
      // Atomic claim prevents accept-vs-revoke races (INV-20)
      const claimed = await InvitationShadowRepository.claimPending(client, shadow.id, "accepted")
      if (!claimed) {
        // Race: another accept or revoke won between our read and the claim.
        const current = await InvitationShadowRepository.findById(client, shadow.id)
        if (current?.status === "accepted") {
          return { workspaceId: shadow.workspace_id }
        }
        throw new HttpError("Invitation is no longer available", { status: 409, code: "INVITATION_REVOKED" })
      }

      // Provision user on regional backend inside the transaction.
      // Failure here auto-rollbacks the claim — shadow stays pending for retry.
      const name = this.resolveDisplayName(user)
      await this.regionalClient.acceptInvitation(shadow.region, shadow.id, {
        workosUserId: user.id,
        email: user.email,
        name,
      })

      // Regional call succeeded — commit membership alongside the claim
      await WorkspaceRegistryRepository.insertMembership(client, shadow.workspace_id, user.id)
      // An invited platform admin should see backoffice links in the joined
      // workspace without waiting for the next control-plane restart.
      await this.platformAdminSync.enqueueIfAdmin(client, user.id)
      return { workspaceId: shadow.workspace_id }
    })

    // Best-effort WorkOS org membership sync (no DB connection held — INV-41)
    const orgId = await this.ensureWorkosOrganization(shadow.workspace_id)
    if (orgId) {
      try {
        await this.workosOrgService.ensureOrganizationMembership({
          organizationId: orgId,
          userId: user.id,
          roleSlug: shadow.role_slug,
        })
      } catch (error) {
        logger.warn({ err: error, workspaceId: shadow.workspace_id }, "Failed to sync WorkOS org membership on accept")
      }
    }

    return result
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
    expiresAt: Date
    inviterWorkosUserId?: string
  }) {
    // Step 1: Insert shadow record (quick DB write)
    const shadow = await InvitationShadowRepository.insert(this.pool, params)

    // Link invites have no email at creation — defer WorkOS until claim.
    if (params.kind === "link" || !params.email) {
      return shadow
    }

    // Step 2: Ensure WorkOS organization exists for this workspace (lazy create, cached)
    const orgId = await this.ensureWorkosOrganization(params.workspaceId)

    // Step 3: Send WorkOS invitation email (no DB connection held — INV-41)
    if (orgId && params.inviterWorkosUserId) {
      await this.sendWorkosInvitationForShadow({
        shadowId: shadow.id,
        email: params.email,
        organizationId: orgId,
        inviterWorkosUserId: params.inviterWorkosUserId,
        roleSlug: shadow.role_slug,
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
    if (row.status === "accepted") {
      throw new HttpError("Invitation already used", { status: 409, code: "INVITATION_ALREADY_CLAIMED" })
    }
    if (row.expires_at <= new Date()) {
      throw new HttpError("Invitation expired", { status: 409, code: "INVITATION_EXPIRED" })
    }

    return {
      workspaceName: row.workspace_name,
      expiresAt: row.expires_at.toISOString(),
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

    // Look up region from full shadow row (the workspace-joined row drops region)
    const fullShadow = await InvitationShadowRepository.findById(this.pool, shadow.id)
    if (!fullShadow) {
      throw new HttpError("Invitation not found", { status: 404, code: "INVITATION_NOT_FOUND" })
    }

    try {
      return await this.regionalClient.claimInvitationLink(fullShadow.region, { token, email })
    } catch (err) {
      if (err instanceof RegionalClaimError) {
        const code = err.upstreamCode()
        if (code === "INVITATION_REVOKED" || code === "INVITATION_EXPIRED" || code === "INVITATION_ALREADY_CLAIMED") {
          throw new HttpError(code, { status: 409, code })
        }
        if (code === "INVITATION_NOT_FOUND") {
          throw new HttpError(code, { status: 404, code })
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
  async acceptLinkClaim(params: { id: string; email: string; inviterWorkosUserId?: string }): Promise<void> {
    // Mirror email onto the local shadow first (idempotent).
    const updated = await InvitationShadowRepository.setEmailFromClaim(this.pool, params.id, params.email, null)
    if (!updated) {
      logger.warn({ id: params.id }, "Link claim received for unknown shadow (or non-link kind)")
      return
    }

    if (updated.workos_invitation_id) {
      // Idempotent replay: WorkOS invite already sent. Nothing to do.
      return
    }

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
    })
  }

  private async sendWorkosInvitationForShadow(params: {
    shadowId: string
    email: string
    organizationId: string
    inviterWorkosUserId: string
    roleSlug: WorkspaceInvitableRole
  }): Promise<void> {
    try {
      const workosInvitation = await this.workosOrgService.sendInvitation({
        organizationId: params.organizationId,
        email: params.email,
        inviterUserId: params.inviterWorkosUserId,
        roleSlug: params.roleSlug,
      })
      await InvitationShadowRepository.setWorkosInvitationId(this.pool, params.shadowId, workosInvitation.id)
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
      }
    }
  }

  /**
   * Update shadow status. When revoking, also revoke the WorkOS invitation
   * if one was sent. Uses atomic claim to prevent accept/revoke races (INV-20).
   */
  async updateStatus(id: string, status: "accepted" | "revoked") {
    // Atomic claim: prevents race where accept commits membership while revoke wins status
    const claimed = await InvitationShadowRepository.claimPending(this.pool, id, status)
    if (!claimed) return false

    // Best-effort WorkOS revocation after the local claim is durable
    if (status === "revoked" && claimed.workos_invitation_id) {
      try {
        await this.workosOrgService.revokeInvitation(claimed.workos_invitation_id)
      } catch (error) {
        const errorCode = getWorkosErrorCode(error)
        if (errorCode === WORKOS_ERROR_CODES.INVITE_NOT_PENDING) {
          logger.warn({ errorCode, shadowId: id }, "WorkOS state conflict when revoking invitation (noop)")
        } else {
          logger.error({ err: error, shadowId: id }, "Failed to revoke WorkOS invitation")
        }
      }
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
