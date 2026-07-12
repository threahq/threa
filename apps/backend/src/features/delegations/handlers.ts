import type { Request, Response } from "express"
import type { Pool } from "pg"
import { z } from "zod"
import { AuthorTypes, type DelegationSummary, type ListDelegationsResponse } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import { checkStreamAccess } from "../streams"
import type { DelegationService } from "./service"
import type { DelegatedTaskWithEvent } from "./repository"

interface Dependencies {
  pool: Pool
  delegationService: DelegationService
}

const listDelegationsQuerySchema = z.object({
  streamId: z.string().min(1),
})

function toSummary(delegation: DelegatedTaskWithEvent): DelegationSummary {
  return {
    id: delegation.id,
    streamId: delegation.streamId,
    title: delegation.title,
    status: delegation.status,
    claimedByLabel: delegation.claimedByLabel,
    resultMessageId: delegation.resultMessageId,
    statusNote: delegation.statusNote,
    createdEventId: delegation.createdEventId,
    createdAt: delegation.createdAt.toISOString(),
    statusChangedAt: delegation.statusChangedAt.toISOString(),
  }
}

/**
 * First-party HTTP surface for delegations (roadmap 5.2): the timeline card's
 * Cancel button and the "In this stream" panel's list. The card itself renders
 * from the `delegation:created` event payload with no fetch; the local-agent
 * lifecycle (claim/heartbeat/complete/fail) is the 5.3 public API. Access is
 * gated on stream access, not ownership: delegations are shared surface, so
 * any member who can see the stream can list and cancel (mirrors follow-up
 * cancel; 404 hides existence from non-members).
 */
export function createDelegationHandlers({ pool, delegationService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = validateRequest(listDelegationsQuerySchema, req.query)

      const access = await checkStreamAccess(pool, streamId, workspaceId, userId)
      if (!access) {
        throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })
      }

      const delegations = await delegationService.listByStream({ workspaceId, streamId })
      const response: ListDelegationsResponse = { delegations: delegations.map(toSummary) }
      res.json(response)
    },

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

    /**
     * "Mark as done" from the card — closes the loop for work executed outside
     * the API path (copy-paste into a local agent). Same access model and
     * race-honest response shape as cancel.
     */
    async markDone(req: Request, res: Response) {
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

      const done = await delegationService.markDone({
        workspaceId,
        id,
        streamId: delegation.streamId,
        completedBy: { actorId: userId, actorType: AuthorTypes.USER },
      })

      res.json({ completed: done !== null })
    },
  }
}
