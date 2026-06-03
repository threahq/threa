import type { Request, Response } from "express"
import { z } from "zod/v4"
import { HttpError, displayNameFromWorkos } from "@threa/backend-common"
import type { BackofficeService } from "./service"

interface Dependencies {
  backofficeService: BackofficeService
}

const createInvitationSchema = z.object({
  email: z.string().email(),
})

/**
 * Comma-separated list of decimal outbox event ids, e.g. `?ids=12,13,14`.
 * Pipeline: 1) split + trim + drop empties, 2) cap at `MAX_STATUS_IDS`,
 * 3) reject anything that isn't a positive decimal integer. We don't parse
 * to bigint here — the service layer owns the BigInt parse and surfaces a
 * clean 400 if the value overflows.
 */
const MAX_STATUS_IDS = 200
const outboxStatusQuerySchema = z.object({
  ids: z
    .string()
    .optional()
    .transform((raw) => {
      if (!raw) return [] as string[]
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    })
    .pipe(
      z
        .array(z.string().regex(/^[1-9]\d*$/, "Outbox event id must be a positive integer"))
        .max(MAX_STATUS_IDS, `Too many ids (max ${MAX_STATUS_IDS})`)
    ),
})

export function createBackofficeHandlers({ backofficeService }: Dependencies) {
  return {
    /**
     * Returns the authenticated user together with their backoffice authorisation
     * state. Deliberately NOT behind the platform-admin gate so the frontend can
     * render a useful "not authorised" screen instead of a bare 403 fetch error.
     */
    async me(req: Request, res: Response) {
      if (!req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }

      const name = displayNameFromWorkos(req.authUser)
      const isPlatformAdmin = await backofficeService.isPlatformAdmin(req.authUser.id)

      res.json({
        id: req.authUser.id,
        email: req.authUser.email,
        name,
        isPlatformAdmin,
      })
    },

    async createWorkspaceOwnerInvitation(req: Request, res: Response) {
      if (!req.authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }

      const parsed = createInvitationSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }

      const invitation = await backofficeService.createWorkspaceOwnerInvitation({
        email: parsed.data.email,
        inviterWorkosUserId: req.authUser.id,
      })

      res.status(201).json({ invitation })
    },

    async listWorkspaceOwnerInvitations(_req: Request, res: Response) {
      const invitations = await backofficeService.listWorkspaceOwnerInvitations()
      res.json({ invitations })
    },

    async revokeWorkspaceOwnerInvitation(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing invitation id", { status: 400, code: "VALIDATION_ERROR" })
      }
      await backofficeService.revokeWorkspaceOwnerInvitation(id)
      res.status(204).end()
    },

    async resendWorkspaceOwnerInvitation(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing invitation id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const invitation = await backofficeService.resendWorkspaceOwnerInvitation(id)
      res.status(201).json({ invitation })
    },

    async listWorkspaces(_req: Request, res: Response) {
      const workspaces = await backofficeService.listAllWorkspaces()
      res.json({ workspaces })
    },

    async getWorkspace(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const workspace = await backofficeService.getWorkspaceDetail(id)
      res.json({ workspace })
    },

    async listWorkspaceMembers(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const members = await backofficeService.listWorkspaceMembers(id)
      res.json({ members })
    },

    async resyncWorkspaceMembers(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const result = await backofficeService.resyncWorkspaceMembers(id)
      res.json({ result })
    },

    async getOutboxEventsStatus(req: Request, res: Response) {
      const parsed = outboxStatusQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        throw new HttpError("Invalid request query", { status: 400, code: "VALIDATION_ERROR" })
      }
      const statuses = await backofficeService.getOutboxEventStatuses(parsed.data.ids)
      res.json({ statuses })
    },

    async listWorkspaceInvitations(req: Request, res: Response) {
      const id = req.params.id
      if (!id) {
        throw new HttpError("Missing workspace id", { status: 400, code: "VALIDATION_ERROR" })
      }
      const invitations = await backofficeService.listWorkspaceInvitations(id)
      res.json({ invitations })
    },

    async getConfig(_req: Request, res: Response) {
      res.json({ config: backofficeService.getConfig() })
    },

    async listWaitlist(_req: Request, res: Response) {
      const waitlist = await backofficeService.listWaitlist()
      res.json({ waitlist })
    },
  }
}
