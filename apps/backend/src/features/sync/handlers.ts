import type { Request, Response } from "express"
import { z } from "zod"
import type { SyncCatchUpResponse } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { permissionGroupsForRole } from "../../lib/outbox"
import type { SyncService } from "./service"

const catchUpQuerySchema = z.object({
  after: z.string().regex(/^\d+$/, "after must be a non-negative integer sync id").default("0"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

interface Dependencies {
  syncService: SyncService
}

export function createSyncHandlers({ syncService }: Dependencies) {
  return {
    async catchUp(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      // Role-derived to stay congruent with the socket join's rooms, so catch-up
      // admits exactly the permission-scoped entries live delivery reached.
      const permissionGroups = permissionGroupsForRole(req.user!.role)

      const parsed = catchUpQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        throw new HttpError("Invalid sync catch-up query", { status: 400, code: "VALIDATION_ERROR" })
      }

      const { entries, head, requiresBootstrap } = await syncService.catchUp({
        workspaceId,
        userId,
        permissionGroups,
        after: BigInt(parsed.data.after),
        limit: parsed.data.limit,
      })

      res.json({
        entries: entries.map((entry) => ({
          syncId: entry.syncId.toString(),
          eventType: entry.eventType,
          payload: entry.payload,
          createdAt: entry.createdAt.toISOString(),
        })),
        head: head.toString(),
        ...(requiresBootstrap ? { requiresBootstrap: true } : {}),
      } satisfies SyncCatchUpResponse)
    },
  }
}
