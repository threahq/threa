import type { Request, Response } from "express"
import { z } from "zod"
import type { SyncCatchUpResponse } from "@threa/types"
import { HttpError } from "../../lib/errors"
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

      const parsed = catchUpQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        throw new HttpError("Invalid sync catch-up query", { status: 400, code: "VALIDATION_ERROR" })
      }

      const { entries, head } = await syncService.catchUp({
        workspaceId,
        userId,
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
      } satisfies SyncCatchUpResponse)
    },
  }
}
