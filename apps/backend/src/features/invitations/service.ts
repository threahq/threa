import { Pool } from "pg"
import { randomBytes, createHash } from "node:crypto"
import { withTransaction, type Querier } from "../../db"
import { InvitationRepository, type Invitation } from "./repository"
import { UserRepository, type WorkspaceService } from "../workspaces"
import { OutboxRepository } from "../../lib/outbox"
import { invitationId } from "../../lib/id"
import { logger } from "../../lib/logger"
import type { InvitationSkipReason, InvitationStatus, WorkspaceInvitableRole } from "@threa/types"

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const LINK_TOKEN_BYTES = 32

function generateLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(LINK_TOKEN_BYTES).toString("base64url")
  return { token, tokenHash: createHash("sha256").update(token).digest("hex") }
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

interface SendInvitationsParams {
  workspaceId: string
  invitedBy: string
  emails: string[]
  role: WorkspaceInvitableRole
}

interface CreateLinkParams {
  workspaceId: string
  invitedBy: string
  role: WorkspaceInvitableRole
  note: string | null
  maxUses?: number | null
  expiresAt?: Date | null
}

interface UpdateLinkParams {
  workspaceId: string
  invitationId: string
  maxUses?: number | null
  expiresAt?: Date | null
}

export interface CreateLinkResult {
  invitation: Invitation
  token: string
}

export interface ClaimLinkResult {
  invitationId?: string
  alreadyMember?: { workspaceId: string }
}

interface SendResult {
  sent: Invitation[]
  skipped: Array<{ email: string; reason: InvitationSkipReason }>
}

export interface AcceptPendingResult {
  accepted: string[]
  failed: Array<{ invitationId: string; email: string; error: string }>
}

export interface WorkosIdentity {
  workosUserId: string
  email: string
  name: string
}

function isExpired(invitation: Invitation, now = new Date()): boolean {
  return invitation.expiresAt !== null && invitation.expiresAt <= now
}

function assertLinkAvailable(invitation: Invitation): void {
  if (invitation.status === "revoked") throw new InvitationLinkError("INVITATION_REVOKED")
  if (isExpired(invitation)) throw new InvitationLinkError("INVITATION_EXPIRED")
  if (invitation.maxUses !== null && invitation.useCount >= invitation.maxUses) {
    throw new InvitationLinkError("INVITATION_EXHAUSTED")
  }
}

function linkState(invitation: Invitation) {
  return {
    parentInvitationId: invitation.id,
    expiresAt: invitation.expiresAt?.toISOString() ?? null,
    maxUses: invitation.maxUses,
    useCount: invitation.useCount,
    revision: invitation.revision,
    status: invitation.status,
  }
}

export class InvitationService {
  constructor(
    private pool: Pool,
    private workspaceService: WorkspaceService
  ) {}

  async sendInvitations(params: SendInvitationsParams): Promise<SendResult> {
    const { workspaceId, invitedBy, role } = params
    const emails = params.emails.map((email) => email.toLowerCase().trim())
    const skipped: SendResult["skipped"] = []
    const inviterWorkosUserId = (await this.getInviterWorkosUserId(workspaceId, invitedBy)) ?? undefined
    const existingUserEmails = await UserRepository.findEmails(this.pool, workspaceId, emails)
    const pendingInvitations = await InvitationRepository.findPendingByEmailsAndWorkspace(
      this.pool,
      emails,
      workspaceId
    )
    const pendingEmails = new Set(pendingInvitations.map((invitation) => invitation.email))
    const emailsToSend: string[] = []

    for (const email of emails) {
      if (existingUserEmails.has(email)) {
        skipped.push({ email, reason: "already_user" })
      } else if (pendingEmails.has(email)) {
        skipped.push({ email, reason: "pending_invitation" })
      } else {
        emailsToSend.push(email)
      }
    }
    if (emailsToSend.length === 0) return { sent: [], skipped }

    const sent = await withTransaction(this.pool, async (client) => {
      const invitations: Invitation[] = []
      for (const email of emailsToSend) {
        const id = invitationId()
        const invitation = await InvitationRepository.insert(client, {
          id,
          workspaceId,
          email,
          role,
          invitedBy,
          expiresAt: new Date(Date.now() + INVITATION_EXPIRY_MS),
        })
        await OutboxRepository.insert(client, "invitation:sent", {
          workspaceId,
          invitationId: id,
          email,
          role,
          inviterWorkosUserId,
        })
        invitations.push(invitation)
      }
      return invitations
    })
    return { sent, skipped }
  }

  async acceptInvitation(invitationId: string, identity: WorkosIdentity): Promise<string | null> {
    return withTransaction(this.pool, (client) => this.acceptInvitationInTransaction(client, invitationId, identity))
  }

  private async acceptInvitationInTransaction(
    client: Querier,
    invitationId: string,
    identity: WorkosIdentity
  ): Promise<string | null> {
    const initial = await InvitationRepository.findById(client, invitationId)
    if (!initial) return null
    const email = identity.email.toLowerCase().trim()
    if (!initial.email || initial.email.toLowerCase() !== email) {
      throw new InvitationAcceptanceError("INVITATION_EMAIL_MISMATCH")
    }

    await InvitationRepository.lockMembershipIdentity(client, initial.workspaceId, identity.workosUserId)
    const parentId = initial.parentLinkId ?? (initial.kind === "link" ? initial.id : null)
    const parent = parentId ? await InvitationRepository.findByIdForUpdate(client, parentId) : null
    const invitation =
      parentId === invitationId ? parent : await InvitationRepository.findByIdForUpdate(client, invitationId)
    if (
      !invitation ||
      invitation.workspaceId !== initial.workspaceId ||
      invitation.parentLinkId !== initial.parentLinkId
    ) {
      return null
    }
    if (!invitation.email || invitation.email.toLowerCase() !== email) {
      throw new InvitationAcceptanceError("INVITATION_EMAIL_MISMATCH")
    }

    const isMember = await UserRepository.isMember(client, invitation.workspaceId, identity.workosUserId)
    if (invitation.status === "accepted") {
      if (isMember && (!invitation.acceptedWorkosUserId || invitation.acceptedWorkosUserId === identity.workosUserId)) {
        return invitation.workspaceId
      }
      return null
    }
    if (invitation.status !== "pending") return null

    if (parent) {
      try {
        assertLinkAvailable(parent)
      } catch (error) {
        if (error instanceof InvitationLinkError) throw new InvitationAcceptanceError(error.code)
        throw error
      }
    } else if (isExpired(invitation)) {
      throw new InvitationAcceptanceError("INVITATION_EXPIRED")
    }

    let consumedByWorkosUserId: string | null = null
    if (!isMember) {
      await this.workspaceService.createUserInTransaction(client, {
        workspaceId: invitation.workspaceId,
        workosUserId: identity.workosUserId,
        email,
        name: identity.name,
        role: invitation.role,
        setupCompleted: false,
      })
      consumedByWorkosUserId = identity.workosUserId
    }

    const accepted = await InvitationRepository.accept(
      client,
      invitation.id,
      new Date(),
      consumedByWorkosUserId,
      consumedByWorkosUserId !== null
    )
    if (!accepted) return null
    if (parent && consumedByWorkosUserId) await InvitationRepository.incrementRevision(client, parent.id)
    const currentParent = parent ? await InvitationRepository.findById(client, parent.id) : null
    await OutboxRepository.insert(client, "invitation:accepted", {
      workspaceId: invitation.workspaceId,
      invitationId: invitation.id,
      email,
      workosUserId: identity.workosUserId,
      userName: identity.name,
      ...(currentParent ? linkState(currentParent) : {}),
    })
    return invitation.workspaceId
  }

  async acceptPendingForEmail(email: string, identity: WorkosIdentity): Promise<AcceptPendingResult> {
    const normalizedEmail = email.toLowerCase().trim()
    const pending = await InvitationRepository.findPendingByEmail(this.pool, normalizedEmail)
    if (pending.length === 0) return { accepted: [], failed: [] }

    return withTransaction(this.pool, async (client) => {
      const accepted: string[] = []
      const failed: AcceptPendingResult["failed"] = []
      for (const invitation of pending) {
        try {
          await client.query("SAVEPOINT accept_inv")
          const workspaceId = await this.acceptInvitationInTransaction(client, invitation.id, identity)
          await client.query("RELEASE SAVEPOINT accept_inv")
          if (workspaceId) accepted.push(workspaceId)
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT accept_inv")
          logger.error({ err: error, invitationId: invitation.id, email }, "Failed to accept invitation")
          failed.push({
            invitationId: invitation.id,
            email: invitation.email ?? normalizedEmail,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return { accepted, failed }
    })
  }

  async revokeInvitation(invitationId: string, workspaceId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const invitation = await InvitationRepository.revoke(client, invitationId, workspaceId, new Date())
      if (!invitation) return false
      await OutboxRepository.insert(client, "invitation:revoked", {
        workspaceId,
        invitationId,
        ...(invitation.kind === "link" && !invitation.parentLinkId ? linkState(invitation) : {}),
      })
      return true
    })
  }

  async resendInvitation(invitationId: string, workspaceId: string): Promise<Invitation | null> {
    const invitation = await InvitationRepository.findById(this.pool, invitationId)
    if (
      !invitation ||
      invitation.workspaceId !== workspaceId ||
      invitation.status !== "pending" ||
      invitation.kind !== "email" ||
      !invitation.email
    ) {
      return null
    }
    await this.revokeInvitation(invitationId, workspaceId)
    const result = await this.sendInvitations({
      workspaceId,
      invitedBy: invitation.invitedBy,
      emails: [invitation.email],
      role: invitation.role,
    })
    return result.sent[0] ?? null
  }

  async listInvitations(workspaceId: string, status?: InvitationStatus): Promise<Invitation[]> {
    await InvitationRepository.markExpired(this.pool, workspaceId)
    return InvitationRepository.listByWorkspace(this.pool, workspaceId, status ? { status } : undefined)
  }

  async createLink(params: CreateLinkParams): Promise<CreateLinkResult> {
    if (params.role !== "member") throw new InvitationLinkError("INVITATION_ROLE_NOT_ALLOWED")
    const { token, tokenHash } = generateLinkToken()
    const id = invitationId()
    const expiresAt = params.expiresAt === undefined ? new Date(Date.now() + INVITATION_EXPIRY_MS) : params.expiresAt
    const maxUses = params.maxUses === undefined ? 1 : params.maxUses
    const invitation = await withTransaction(this.pool, async (client) => {
      const created = await InvitationRepository.insertLink(client, {
        id,
        workspaceId: params.workspaceId,
        role: params.role,
        invitedBy: params.invitedBy,
        tokenHash,
        note: params.note,
        expiresAt,
        maxUses,
      })
      await OutboxRepository.insert(client, "invitation:link-created", {
        workspaceId: params.workspaceId,
        invitationId: id,
        tokenHash,
        role: params.role,
        ...linkState(created),
      })
      return created
    })
    return { invitation, token }
  }

  async updateLink(params: UpdateLinkParams): Promise<Invitation | null> {
    return withTransaction(this.pool, async (client) => {
      const invitation = await InvitationRepository.updateLink(client, params.invitationId, params.workspaceId, {
        maxUses: params.maxUses,
        expiresAt: params.expiresAt,
      })
      if (!invitation) return null
      await OutboxRepository.insert(client, "invitation:link-created", {
        workspaceId: invitation.workspaceId,
        invitationId: invitation.id,
        tokenHash: invitation.tokenHash!,
        role: invitation.role,
        ...linkState(invitation),
      })
      return invitation
    })
  }

  async claimLinkByToken(token: string, rawEmail: string): Promise<ClaimLinkResult> {
    const email = rawEmail.toLowerCase().trim()
    const tokenHash = hashInvitationToken(token)
    return withTransaction(this.pool, async (client) => {
      const parent = await InvitationRepository.findRootByTokenHashForUpdate(client, tokenHash)
      if (!parent) throw new InvitationLinkError("INVITATION_NOT_FOUND")
      if (parent.status === "revoked") throw new InvitationLinkError("INVITATION_REVOKED")

      let child: Invitation
      if (parent.role === "admin") {
        assertLinkAvailable(parent)
        if (parent.email && parent.email.toLowerCase() !== email) {
          throw new InvitationLinkError("INVITATION_EXHAUSTED")
        }
        if (parent.email) {
          child = parent
        } else {
          const claimed = await InvitationRepository.claimLegacyAdminLink(client, parent.id, email)
          if (!claimed) throw new InvitationLinkError("INVITATION_EXHAUSTED")
          child = claimed
        }
      } else {
        if (isExpired(parent)) throw new InvitationLinkError("INVITATION_EXPIRED")
        const legacyClaim = parent.email?.toLowerCase() === email ? parent : null
        if (parent.email && !legacyClaim && parent.maxUses === 1 && parent.acceptanceConsumesCapacity !== false) {
          throw new InvitationLinkError("INVITATION_EXHAUSTED")
        }
        const existingChild = legacyClaim ?? (await InvitationRepository.findLinkChild(client, parent.id, email))
        if (!existingChild) assertLinkAvailable(parent)
        child =
          existingChild ??
          (await InvitationRepository.insertOrFindLinkChild(client, {
            id: invitationId(),
            parent,
            email,
          }))
      }
      const inviterWorkosUserId =
        (await this.getInviterWorkosUserId(parent.workspaceId, parent.invitedBy, client)) ?? undefined
      await OutboxRepository.insert(client, "invitation:link-claimed", {
        workspaceId: parent.workspaceId,
        invitationId: child.id,
        email,
        role: parent.role,
        inviterWorkosUserId,
        ...linkState(parent),
      })
      const memberMatches = await UserRepository.findEmails(client, parent.workspaceId, [email])
      if (memberMatches.has(email)) return { alreadyMember: { workspaceId: parent.workspaceId } }
      return { invitationId: child.id }
    })
  }

  private async getInviterWorkosUserId(
    workspaceId: string,
    invitedBy: string,
    db: Querier = this.pool
  ): Promise<string | null> {
    return (await UserRepository.findById(db, workspaceId, invitedBy))?.workosUserId ?? null
  }
}

export type InvitationLinkErrorCode =
  | "INVITATION_NOT_FOUND"
  | "INVITATION_REVOKED"
  | "INVITATION_EXPIRED"
  | "INVITATION_EXHAUSTED"
  | "INVITATION_ROLE_NOT_ALLOWED"

export class InvitationLinkError extends Error {
  constructor(public readonly code: InvitationLinkErrorCode) {
    super(code)
    this.name = "InvitationLinkError"
  }
}

export type InvitationAcceptanceErrorCode = InvitationLinkErrorCode | "INVITATION_EMAIL_MISMATCH"

export class InvitationAcceptanceError extends Error {
  constructor(public readonly code: InvitationAcceptanceErrorCode) {
    super(code)
    this.name = "InvitationAcceptanceError"
  }
}
