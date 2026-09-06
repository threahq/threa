import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError } from "@threahq/backend-common"
import { WORKSPACE_INVITABLE_ROLES, WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import type { InvitationShadowService } from "./service"

interface Dependencies {
  shadowService: InvitationShadowService
}

const createShadowSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    region: z.string().min(1),
    expiresAt: z.string().datetime().nullable(),
    maxUses: z.number().int().positive().nullable().optional(),
    useCount: z.number().int().nonnegative().optional(),
    revision: z.number().int().nonnegative().optional(),
    status: z.enum(["pending", "accepted", "expired", "revoked"]).optional(),
    kind: z.enum(["email", "link"]).default("email"),
    email: z.string().email().nullable().optional(),
    tokenHash: z.string().min(1).nullable().optional(),
    roleSlug: z.enum(WORKSPACE_INVITABLE_ROLES).default(WORKSPACE_ROLE_SLUGS.MEMBER),
    inviterWorkosUserId: z.string().min(1).optional(),
  })
  .refine(
    (v) => {
      if (v.kind === "email") return !!v.email
      if (v.kind === "link") return !!v.tokenHash
      return true
    },
    { message: "email is required for kind='email'; tokenHash is required for kind='link'" }
  )

const updateShadowSchema = z.union([
  z.object({
    expiresAt: z.string().datetime().nullable(),
    maxUses: z.number().int().positive().nullable(),
    useCount: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    status: z.enum(["pending", "accepted", "expired", "revoked"]),
  }),
  z.object({ status: z.literal("revoked") }),
])

const lookupSchema = z.object({
  token: z.string().min(1).max(200),
})

const claimSchema = z.object({
  token: z.string().min(1).max(200),
  email: z.string().email(),
})

function optionalDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined
  return value === null ? null : new Date(value)
}

const acceptedSchema = z.object({
  workspaceId: z.string().min(1),
  email: z.string().email(),
  workosUserId: z.string().min(1),
  parentInvitationId: z.string().min(1).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  useCount: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative().optional(),
  status: z.enum(["pending", "accepted", "expired", "revoked"]).optional(),
})

const notifyClaimSchema = z.object({
  childInvitationId: z.string().min(1).optional(),
  email: z.string().email(),
  expiresAt: z.string().datetime().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  useCount: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative().optional(),
  inviterWorkosUserId: z.string().min(1).optional(),
})

export function createInvitationShadowHandlers({ shadowService }: Dependencies) {
  return {
    async create(req: Request, res: Response) {
      const parsed = createShadowSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const shadow = await shadowService.createShadow({
        id: parsed.data.id,
        workspaceId: parsed.data.workspaceId,
        region: parsed.data.region,
        kind: parsed.data.kind,
        email: parsed.data.email ?? null,
        tokenHash: parsed.data.tokenHash ?? null,
        roleSlug: parsed.data.roleSlug,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        maxUses: parsed.data.maxUses,
        useCount: parsed.data.useCount,
        revision: parsed.data.revision,
        status: parsed.data.status,
        inviterWorkosUserId: parsed.data.inviterWorkosUserId,
      })

      res.status(201).json({ shadow })
    },

    async update(req: Request, res: Response) {
      const { id } = req.params
      const parsed = updateShadowSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const updated =
        "revision" in parsed.data
          ? await shadowService.updateLinkSnapshot(id, {
              ...parsed.data,
              expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
            })
          : await shadowService.updateStatus(id, parsed.data.status)
      if (!updated) {
        throw new HttpError("Invitation shadow not found", { status: 404, code: "NOT_FOUND" })
      }

      res.json({ ok: true })
    },

    /** Public/unauthenticated: resolve a /join token to workspace metadata */
    async lookup(req: Request, res: Response) {
      const parsed = lookupSchema.safeParse({ token: req.query.token })
      if (!parsed.success) {
        throw new HttpError("Missing token", { status: 400, code: "VALIDATION_ERROR" })
      }
      const result = await shadowService.lookupByToken(parsed.data.token)
      res.json(result)
    },

    /** Public/unauthenticated: claim a /join link by submitting an email */
    async claim(req: Request, res: Response) {
      const parsed = claimSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const result = await shadowService.claimByToken(parsed.data.token, parsed.data.email)
      res.json(result)
    },

    /** Internal: regional notifies CP that a link was claimed; CP triggers WorkOS invite */
    async notifyClaim(req: Request, res: Response) {
      const parsed = notifyClaimSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      await shadowService.acceptLinkClaim({
        id: req.params.id,
        childInvitationId: parsed.data.childInvitationId,
        email: parsed.data.email,
        expiresAt: optionalDate(parsed.data.expiresAt),
        maxUses: parsed.data.maxUses,
        useCount: parsed.data.useCount,
        revision: parsed.data.revision,
        inviterWorkosUserId: parsed.data.inviterWorkosUserId,
      })
      res.json({ ok: true })
    },

    async acknowledgeAccepted(req: Request, res: Response) {
      const parsed = acceptedSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      await shadowService.reconcileAccepted({
        id: req.params.id,
        workspaceId: parsed.data.workspaceId,
        email: parsed.data.email,
        workosUserId: parsed.data.workosUserId,
        parentInvitationId: parsed.data.parentInvitationId,
        expiresAt: optionalDate(parsed.data.expiresAt),
        maxUses: parsed.data.maxUses,
        useCount: parsed.data.useCount,
        revision: parsed.data.revision,
        status: parsed.data.status,
      })
      res.json({ ok: true })
    },

    /** User-facing: accept a pending invitation */
    async accept(req: Request, res: Response) {
      if (!req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }

      const { workspaceId } = await shadowService.acceptShadow(req.params.id, {
        id: req.authUser.id,
        email: req.authUser.email,
        firstName: req.authUser.firstName,
        lastName: req.authUser.lastName,
      })

      res.json({ workspaceId })
    },
  }
}
