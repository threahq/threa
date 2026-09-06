import { z } from "zod"
import type { Request, Response } from "express"
import { WORKSPACE_INVITABLE_ROLES, WORKSPACE_ROLE_SLUGS } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import type { Invitation } from "./repository"
import type { InvitationService } from "./service"
import { InvitationLinkError } from "./service"

/**
 * Project an `Invitation` to its wire shape. We deliberately drop `tokenHash`
 * (no reason to expose it on responses) so callers only see the fields
 * declared in `WorkspaceInvitation`.
 */
function toWire(invitation: Invitation) {
  const {
    tokenHash: _tokenHash,
    parentLinkId: _parentLinkId,
    acceptedWorkosUserId: _acceptedWorkosUserId,
    acceptanceConsumesCapacity: _acceptanceConsumesCapacity,
    revision: _revision,
    revokedAt: _revokedAt,
    ...wire
  } = invitation
  return wire
}

const invitableRoleSchema = z.enum(WORKSPACE_INVITABLE_ROLES)

const sendInvitationsSchema = z.object({
  emails: z
    .array(z.string().email("Invalid email address"))
    .min(1, "At least one email is required")
    .max(20, "Maximum 20 emails per request"),
  role: invitableRoleSchema.optional().default(WORKSPACE_ROLE_SLUGS.MEMBER),
})

const maxUsesSchema = z.number().int().positive().max(2_147_483_647).nullable().optional()

const futureExpiry = (value: string | null | undefined) =>
  value === undefined || value === null || new Date(value).getTime() > Date.now()

const createLinkSchema = z
  .object({
    role: z.literal(WORKSPACE_ROLE_SLUGS.MEMBER),
    note: z.string().trim().max(200).optional(),
    maxUses: maxUsesSchema,
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((value) => futureExpiry(value.expiresAt), { message: "expiresAt must be in the future" })

const updateLinkSchema = z
  .object({
    maxUses: maxUsesSchema,
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((value) => value.maxUses !== undefined || value.expiresAt !== undefined)
  .refine((value) => futureExpiry(value.expiresAt), { message: "expiresAt must be in the future" })

const claimLinkSchema = z.object({
  token: z.string().min(1).max(200),
  email: z.string().email(),
})

function parseOptionalExpiry(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value
  return new Date(value)
}

interface Dependencies {
  invitationService: InvitationService
}

export function createInvitationHandlers({ invitationService }: Dependencies) {
  return {
    async send(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id

      const { emails, role } = validateRequest(sendInvitationsSchema, req.body)

      const sendResult = await invitationService.sendInvitations({
        workspaceId,
        invitedBy: userId,
        emails,
        role,
      })

      res.status(201).json({
        sent: sendResult.sent.map(toWire),
        skipped: sendResult.skipped,
      })
    },

    async list(req: Request, res: Response) {
      const workspaceId = req.workspaceId!

      const invitations = await invitationService.listInvitations(workspaceId)

      res.json({ invitations: invitations.map(toWire) })
    },

    async revoke(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const { invitationId } = req.params

      const revoked = await invitationService.revokeInvitation(invitationId, workspaceId)

      if (!revoked) {
        return res.status(404).json({ error: "Invitation not found or already processed" })
      }

      res.json({ success: true })
    },

    async resend(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const { invitationId } = req.params

      const invitation = await invitationService.resendInvitation(invitationId, workspaceId)

      if (!invitation) {
        return res.status(404).json({ error: "Invitation not found or not pending" })
      }

      res.json({ invitation: toWire(invitation) })
    },

    async createLink(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id

      const data = validateRequest(createLinkSchema, req.body)

      const { invitation, token } = await invitationService.createLink({
        workspaceId,
        invitedBy: userId,
        role: data.role,
        note: data.note?.trim() || null,
        maxUses: data.maxUses,
        expiresAt: parseOptionalExpiry(data.expiresAt),
      })

      // Token returned exactly once. Frontend constructs the join URL from
      // window.location.origin so we don't have to plumb a public-app-URL env
      // through to the regional backend (and it just-works across staging,
      // PR previews, and prod without per-env config).
      res.status(201).json({ invitation: toWire(invitation), token })
    },

    async updateLink(req: Request, res: Response) {
      const data = validateRequest(updateLinkSchema, req.body)
      const invitation = await invitationService.updateLink({
        workspaceId: req.workspaceId!,
        invitationId: req.params.invitationId,
        maxUses: data.maxUses,
        expiresAt: parseOptionalExpiry(data.expiresAt),
      })
      if (!invitation) {
        throw new HttpError("Invitation link cannot be updated", { status: 409, code: "INVITATION_NOT_EDITABLE" })
      }
      res.json({ invitation: toWire(invitation) })
    },

    /**
     * Internal-only (called from CP): atomically claim a link by its token.
     * Translates `InvitationLinkError` into `HttpError` so the central error
     * middleware ships consistent error codes.
     */
    async claimLink(req: Request, res: Response) {
      const result = claimLinkSchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      try {
        const claimResult = await invitationService.claimLinkByToken(result.data.token, result.data.email)
        res.json({
          ok: true,
          ...(claimResult.invitationId ? { invitationId: claimResult.invitationId } : {}),
          ...(claimResult.alreadyMember ? { alreadyMember: claimResult.alreadyMember } : {}),
        })
      } catch (err) {
        if (err instanceof InvitationLinkError) {
          throw new HttpError(err.code, { status: err.code === "INVITATION_NOT_FOUND" ? 404 : 409, code: err.code })
        }
        throw err
      }
    },
  }
}
