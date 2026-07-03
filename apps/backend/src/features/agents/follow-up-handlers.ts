import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { checkStreamAccess } from "../streams"
import type { AgentFollowUpService } from "./follow-up-service"

interface Dependencies {
  pool: Pool
  agentFollowUpService: AgentFollowUpService
}

/**
 * HTTP surface for agent follow-ups (roadmap 1.3). Only cancel is exposed to
 * first-party clients — the timeline card's Cancel button. Scheduling and
 * listing stay agent-only (the persona's tools); a member's sole affordance is
 * to drop a follow-up they can see. Access is gated on stream access, not
 * ownership: any member who can see the follow-up's stream can cancel it, since
 * the card is shared surface (INV-62 via `checkStreamAccess`).
 */
export function createAgentFollowUpHandlers({ pool, agentFollowUpService }: Dependencies) {
  return {
    async cancel(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      const followUp = await agentFollowUpService.getById({ workspaceId, followUpId: id })
      if (!followUp) {
        throw new HttpError("Follow-up not found", { status: 404, code: "FOLLOW_UP_NOT_FOUND" })
      }

      const access = await checkStreamAccess(pool, followUp.streamId, workspaceId, userId)
      if (!access) {
        throw new HttpError("Follow-up not found", { status: 404, code: "FOLLOW_UP_NOT_FOUND" })
      }

      const cancelled = await agentFollowUpService.cancel({
        workspaceId,
        id,
        streamId: followUp.streamId,
        cancelledBy: { actorId: userId, actorType: AuthorTypes.USER },
      })

      // `null` means the cancel lost the race to the fire worker (already
      // fired/cancelled). Idempotent from the caller's view: report which
      // happened rather than erroring, so a double-click is harmless.
      res.json({ cancelled: cancelled !== null })
    },
  }
}
