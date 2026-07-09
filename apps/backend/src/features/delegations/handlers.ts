import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { checkStreamAccess } from "../streams"
import type { DelegationService } from "./service"

interface Dependencies {
  pool: Pool
  delegationService: DelegationService
}

/**
 * First-party HTTP surface for delegations (roadmap 5.2). Only cancel is
 * exposed — the timeline card's Cancel button; the card itself renders from
 * the `delegation:created` event payload with no fetch, and the local-agent
 * lifecycle (claim/heartbeat/complete/fail) is the 5.3 public API. Access is
 * gated on stream access, not ownership: the card is shared surface, so any
 * member who can see the stream can cancel (mirrors follow-up cancel; 404
 * hides existence from non-members).
 */
export function createDelegationHandlers({ pool, delegationService }: Dependencies) {
  return {
    async cancel(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const id = req.params.id!

      const delegation = await delegationService.getById({ workspaceId, id })
      if (!delegation) {
        throw new HttpError("Delegation not found", { status: 404, code: "DELEGATION_NOT_FOUND" })
      }

      const access = await checkStreamAccess(pool, delegation.streamId, workspaceId, userId)
      if (!access) {
        throw new HttpError("Delegation not found", { status: 404, code: "DELEGATION_NOT_FOUND" })
      }

      const cancelled = await delegationService.cancel({
        workspaceId,
        id,
        streamId: delegation.streamId,
        cancelledBy: { actorId: userId, actorType: AuthorTypes.USER },
      })

      // `null` means the delegation already reached a terminal state — the
      // cancel lost the race. Report which happened rather than erroring, so a
      // double-click is harmless.
      res.json({ cancelled: cancelled !== null })
    },
  }
}
