import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import type { BotAccessRequestService } from "./service"

/**
 * Reads stream membership (thread→root aware). Satisfied by `StreamService` —
 * injected as a narrow interface so the handlers stay decoupled (INV-12).
 */
export interface StreamMemberChecker {
  isMember(streamId: string, memberId: string): Promise<boolean>
}

interface Dependencies {
  botAccessRequestService: BotAccessRequestService
  streamService: StreamMemberChecker
}

/**
 * First-party HTTP surface for bot access requests (F3): the Approve / Deny
 * buttons on the request card. The approver must be a stream MEMBER
 * (`stream_members`, thread→root aware) — deliberately stricter than the
 * delegation card's `checkStreamAccess` gate (brief decision 4): granting a bot
 * standing machine-access to a stream is more consequential than flipping a
 * card, so a mere viewer cannot do it. 404 (not 403) on a non-member, matching
 * the rest of the feature's existence-hiding.
 */
export function createBotAccessRequestHandlers({ botAccessRequestService, streamService }: Dependencies) {
  async function loadForResolver(req: Request) {
    const userId = req.user!.id
    const workspaceId = req.workspaceId!
    const id = req.params.id!

    const request = await botAccessRequestService.getById({ workspaceId, id })
    if (!request) {
      throw new HttpError("Bot access request not found", { status: 404, code: "BOT_ACCESS_REQUEST_NOT_FOUND" })
    }
    if (!(await streamService.isMember(request.streamId, userId))) {
      throw new HttpError("Bot access request not found", { status: 404, code: "BOT_ACCESS_REQUEST_NOT_FOUND" })
    }
    return { userId, workspaceId, id, streamId: request.streamId }
  }

  return {
    async approve(req: Request, res: Response) {
      const { userId, workspaceId, id, streamId } = await loadForResolver(req)
      const approved = await botAccessRequestService.approve({ workspaceId, id, streamId, approvedBy: userId })
      // `null` means the request already reached a terminal state — the approve
      // lost the race. Report which happened rather than erroring (double-click
      // safe), same as the delegation cancel/markDone shape.
      res.json({ approved: approved !== null })
    },

    async deny(req: Request, res: Response) {
      const { userId, workspaceId, id, streamId } = await loadForResolver(req)
      const denied = await botAccessRequestService.deny({ workspaceId, id, streamId, deniedBy: userId })
      res.json({ denied: denied !== null })
    },
  }
}
