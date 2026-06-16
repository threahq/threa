import { Pool } from "pg"
import { randomBytes, createHash } from "node:crypto"
import { withTransaction, type Querier } from "../../db"
import { InvitationRepository, type Invitation } from "./repository"
import { UserRepository, type WorkspaceService } from "../workspaces"
import { OutboxRepository } from "../../lib/outbox"
import { invitationId } from "../../lib/id"
import { logger } from "../../lib/logger"
import type { InvitationSkipReason, InvitationStatus, WorkspaceInvitableRole } from "@threa/types"

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const LINK_TOKEN_BYTES = 32 // 256 bits → ~43 base64url chars

function generateLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(LINK_TOKEN_BYTES).toString("base64url")
  const tokenHash = createHash("sha256").update(token).digest("hex")
  return { token, tokenHash }
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

interface SendInvitationsParams {
  workspaceId: string
  invitedBy: string // user_id
  emails: string[]
  role: WorkspaceInvitableRole
}

interface CreateLinkParams {
  workspaceId: string
  invitedBy: string
  role: WorkspaceInvitableRole
  note: string | null
}

export interface CreateLinkResult {
  invitation: Invitation
  /** Plaintext claim token. Returned exactly once; never persisted. */
  token: string
}

export interface ClaimLinkResult {
  /** When the email already belongs to a workspace member; the link is consumed and the caller should be redirected to login. */
  alreadyMember?: { workspaceId: string }
}

interface SendResult {
  sent: Invitation[]
  skipped: Array<{ email: string; reason: InvitationSkipReason }>
}

export interface AcceptPendingResult {
  accepted: string[] // workspace IDs
  failed: Array<{ invitationId: string; email: string; error: string }>
}

export interface WorkosIdentity {
  workosUserId: string
  email: string
  name: string
}

export class InvitationService {
  constructor(
    private pool: Pool,
    private workspaceService: WorkspaceService
  ) {}

  async sendInvitations(params: SendInvitationsParams): Promise<SendResult> {
    const { workspaceId, invitedBy, role } = params
    const emails = params.emails.map((e) => e.toLowerCase().trim())

    const skipped: SendResult["skipped"] = []

    // Look up the inviter's WorkOS user ID for the outbox payload
    // (the control-plane uses this to send the WorkOS email)
    const inviterWorkosUserId = (await this.getInviterWorkosUserId(workspaceId, invitedBy)) ?? undefined

    const existingUserEmails = await UserRepository.findEmails(this.pool, workspaceId, emails)

    const pendingInvitations = await InvitationRepository.findPendingByEmailsAndWorkspace(
      this.pool,
      emails,
      workspaceId
    )
    const pendingEmails = new Set(pendingInvitations.map((inv) => inv.email))

    const emailsToSend: string[] = []
    for (const email of emails) {
      if (existingUserEmails.has(email)) {
        skipped.push({ email, reason: "already_user" })
        continue
      }
      if (pendingEmails.has(email)) {
        skipped.push({ email, reason: "pending_invitation" })
        continue
      }
      emailsToSend.push(email)
    }

    if (emailsToSend.length === 0) return { sent: [], skipped }

    // Single transaction — all invitation inserts + outbox events
    const sent = await withTransaction(this.pool, async (client) => {
      const invitations: Invitation[] = []
      for (const email of emailsToSend) {
        const id = invitationId()
        const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS)

        const inv = await InvitationRepository.insert(client, {
          id,
          workspaceId,
          email,
          role,
          invitedBy,
          expiresAt,
        })

        await OutboxRepository.insert(client, "invitation:sent", {
          workspaceId,
          invitationId: id,
          email,
          role,
          inviterWorkosUserId,
        })

        invitations.push(inv)
      }
      return invitations
    })

    return { sent, skipped }
  }

  async acceptInvitation(invitationId: string, identity: WorkosIdentity): Promise<string | null> {
    return withTransaction(this.pool, async (client) => {
      return this.acceptInvitationInTransaction(client, invitationId, identity)
    })
  }

  private async acceptInvitationInTransaction(
    client: Querier,
    invitationId: string,
    identity: WorkosIdentity
  ): Promise<string | null> {
    const now = new Date()
    const updated = await InvitationRepository.updateStatus(client, invitationId, "accepted", {
      acceptedAt: now,
      notExpiredAt: now,
    })

    if (!updated) {
      // Invitation not in pending state — check if this is an idempotent replay.
      // The control-plane retries acceptance if its local DB write failed after the
      // regional call succeeded, so we must return success when the user is already
      // a workspace member (rather than 404, which would leave the shadow stuck).
      const invitation = await InvitationRepository.findById(client, invitationId)
      if (invitation?.status === "accepted") {
        const isMember = await UserRepository.isMember(client, invitation.workspaceId, identity.workosUserId)
        if (isMember) return invitation.workspaceId
      }
      return null
    }

    const invitation = await InvitationRepository.findById(client, invitationId)
    if (!invitation) return null

    // Check if already in the workspace (race condition safety)
    const isMember = await UserRepository.isMember(client, invitation.workspaceId, identity.workosUserId)
    if (isMember) return invitation.workspaceId

    await this.workspaceService.createUserInTransaction(client, {
      workspaceId: invitation.workspaceId,
      workosUserId: identity.workosUserId,
      email: identity.email,
      name: identity.name,
      role: invitation.role,
      setupCompleted: false,
    })

    // By the time an invitation is acceptable, email is bound — either it was
    // an email invite (set at creation) or a link invite that's been claimed.
    // Fall back to the authenticated identity's email defensively.
    await OutboxRepository.insert(client, "invitation:accepted", {
      workspaceId: invitation.workspaceId,
      invitationId: invitation.id,
      email: invitation.email ?? identity.email,
      workosUserId: identity.workosUserId,
      userName: identity.name,
    })

    return invitation.workspaceId
  }

  async acceptPendingForEmail(email: string, identity: WorkosIdentity): Promise<AcceptPendingResult> {
    const pending = await InvitationRepository.findPendingByEmail(this.pool, email.toLowerCase())
    if (pending.length === 0) return { accepted: [], failed: [] }

    return withTransaction(this.pool, async (client) => {
      const accepted: string[] = []
      const failed: AcceptPendingResult["failed"] = []

      for (const invitation of pending) {
        try {
          // Savepoint allows partial success: if one invitation fails,
          // we rollback just that one and continue with the rest
          await client.query("SAVEPOINT accept_inv")
          const wsId = await this.acceptInvitationInTransaction(client, invitation.id, identity)
          await client.query("RELEASE SAVEPOINT accept_inv")

          if (wsId) {
            accepted.push(wsId)
          }
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT accept_inv")
          logger.error({ err, invitationId: invitation.id, email }, "Failed to accept invitation")
          failed.push({
            invitationId: invitation.id,
            email: invitation.email ?? email,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return { accepted, failed }
    })
  }

  async revokeInvitation(invitationId: string, workspaceId: string): Promise<boolean> {
    // Update local status + outbox event in one transaction.
    // The outbox event triggers shadow sync → CP handles WorkOS revocation.
    const revoked = await withTransaction(this.pool, async (client) => {
      const inv = await InvitationRepository.findById(client, invitationId)
      if (!inv || inv.workspaceId !== workspaceId) return false

      const updated = await InvitationRepository.updateStatus(client, invitationId, "revoked", {
        revokedAt: new Date(),
      })

      if (updated) {
        await OutboxRepository.insert(client, "invitation:revoked", {
          workspaceId,
          invitationId,
        })
      }

      return updated
    })

    return revoked
  }

  async resendInvitation(invitationId: string, workspaceId: string): Promise<Invitation | null> {
    const invitation = await InvitationRepository.findById(this.pool, invitationId)
    if (!invitation || invitation.workspaceId !== workspaceId || invitation.status !== "pending") {
      return null
    }
    // Resend only makes sense for email invites. Link invites without a bound
    // email have nothing to resend; once a link is claimed, the recipient gets
    // the WorkOS email automatically. Admin can revoke + create a new link.
    if (invitation.kind !== "email" || !invitation.email) {
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
    // Lazy expiration: mark expired before listing
    await InvitationRepository.markExpired(this.pool, workspaceId)
    return InvitationRepository.listByWorkspace(this.pool, workspaceId, status ? { status } : undefined)
  }

  /**
   * Create an unclaimed link invitation. The plaintext token is returned exactly
   * once; only the SHA-256 hash is persisted. The recipient's email is bound
   * later via `claimLinkByToken`. WorkOS is not contacted at create time —
   * there's no email yet to invite.
   */
  async createLink(params: CreateLinkParams): Promise<CreateLinkResult> {
    const { token, tokenHash } = generateLinkToken()
    const id = invitationId()
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS)

    const invitation = await withTransaction(this.pool, async (client) => {
      const inv = await InvitationRepository.insertLink(client, {
        id,
        workspaceId: params.workspaceId,
        role: params.role,
        invitedBy: params.invitedBy,
        tokenHash,
        note: params.note,
        expiresAt,
      })

      // Mirror to control-plane via outbox so the public /join lookup can
      // resolve workspace metadata without a regional round-trip.
      await OutboxRepository.insert(client, "invitation:link-created", {
        workspaceId: params.workspaceId,
        invitationId: id,
        tokenHash,
        role: params.role,
        expiresAt: expiresAt.toISOString(),
      })

      return inv
    })

    return { invitation, token }
  }

  /**
   * Atomic single-use claim. Binds an email to a previously unclaimed link
   * invitation, then triggers the existing WorkOS-invite path so the recipient
   * receives a verification email. Returns `alreadyMember` if the email
   * already belongs to a workspace member; the row is consumed in that case
   * so the link can't be reused.
   */
  async claimLinkByToken(token: string, rawEmail: string): Promise<ClaimLinkResult> {
    const email = rawEmail.toLowerCase().trim()
    const tokenHash = hashInvitationToken(token)

    // Look up first to surface specific error codes (revoked vs. expired vs. claimed)
    const existing = await InvitationRepository.findByTokenHash(this.pool, tokenHash)
    if (!existing || existing.kind !== "link") {
      throw new InvitationLinkError("INVITATION_NOT_FOUND")
    }
    if (existing.status === "revoked") throw new InvitationLinkError("INVITATION_REVOKED")
    if (existing.status === "expired" || existing.expiresAt <= new Date()) {
      throw new InvitationLinkError("INVITATION_EXPIRED")
    }
    if (existing.status === "accepted" || existing.email !== null) {
      throw new InvitationLinkError("INVITATION_ALREADY_CLAIMED")
    }

    // Atomic claim: bind email + write outbox event in one tx.
    // Concurrent claimers race on the WHERE clause; loser sees null and 409s.
    const claimed = await withTransaction(this.pool, async (client) => {
      const updated = await InvitationRepository.claimLinkByTokenHash(client, tokenHash, email)
      if (!updated) return null

      const inviterWorkosUserId =
        (await this.getInviterWorkosUserId(updated.workspaceId, updated.invitedBy)) ?? undefined

      await OutboxRepository.insert(client, "invitation:link-claimed", {
        workspaceId: updated.workspaceId,
        invitationId: updated.id,
        email,
        role: updated.role,
        inviterWorkosUserId,
      })

      return updated
    })

    if (!claimed) throw new InvitationLinkError("INVITATION_ALREADY_CLAIMED")

    // If the email is already a member of this workspace, short-circuit:
    // they don't need a new WorkOS invite, they just need to log in. The link
    // is consumed regardless so it can't be reused.
    const memberMatches = await UserRepository.findEmails(this.pool, claimed.workspaceId, [email])
    if (memberMatches.has(email)) {
      return { alreadyMember: { workspaceId: claimed.workspaceId } }
    }

    return {}
  }

  private async getInviterWorkosUserId(workspaceId: string, invitedBy: string): Promise<string | null> {
    const inviterUser = await UserRepository.findById(this.pool, workspaceId, invitedBy)
    return inviterUser?.workosUserId ?? null
  }
}

export type InvitationLinkErrorCode =
  | "INVITATION_NOT_FOUND"
  | "INVITATION_REVOKED"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_CLAIMED"

export class InvitationLinkError extends Error {
  constructor(public readonly code: InvitationLinkErrorCode) {
    super(code)
    this.name = "InvitationLinkError"
  }
}
