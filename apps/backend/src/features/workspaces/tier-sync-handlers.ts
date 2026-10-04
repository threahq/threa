import type { Request, Response } from "express"
import type { Pool } from "pg"
import { z } from "zod"
import { WORKSPACE_TIER_VALUES } from "@threahq/types"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import { WorkspaceRepository } from "./repository"

const syncTierSchema = z.object({ workspaceId: z.string().min(1), tier: z.enum(WORKSPACE_TIER_VALUES) }).strict()

interface Dependencies {
  pool: Pool
}

export function createWorkspaceTierSyncHandlers({ pool }: Dependencies) {
  return {
    /**
     * Control-plane fan-out: full snapshot of the tier, so replays are idempotent. A missing row
     * answers 404 so the control plane's outbox retries until the workspace exists here.
     */
    async sync(req: Request, res: Response) {
      const { workspaceId, tier } = validateRequest(syncTierSchema, req.body)
      if (!(await WorkspaceRepository.updateTier(pool, workspaceId, tier))) {
        throw new HttpError("Workspace not found", { status: 404, code: "WORKSPACE_NOT_FOUND" })
      }
      res.status(204).send()
    },
  }
}
