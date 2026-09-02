import type { Request, Response } from "express"
import type { Pool } from "pg"
import { z } from "zod"
import { AuthorTypes, type SubagentSummary } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import { checkStreamAccess } from "../streams"
import { SubagentAlreadyActiveError } from "./repository"
import type { SubagentService } from "./service"

interface Dependencies {
  pool: Pool
  subagentService: SubagentService
}

const subagentIdParamsSchema = z.object({
  id: z.string().min(1),
})

/**
 * First-party HTTP surface for subagent runs: the card's Cancel and Try again
 * buttons. The card itself renders from the `subagent:created` payload with no
 * fetch. Access is gated on the PARENT stream, not ownership — a subagent is
 * shared surface like a delegation, so any member who can see the stream can
 * stop or restart it, and a 404 hides existence from everyone else.
 */
export function createSubagentHandlers({ pool, subagentService }: Dependencies) {
  const loadAccessible = async (req: Request) => {
    const userId = req.user!.id
    const workspaceId = req.workspaceId!
    const { id } = validateRequest(subagentIdParamsSchema, req.params)

    const run = await subagentService.getById({ workspaceId, id })
    if (!run || !(await checkStreamAccess(pool, run.parentStreamId, workspaceId, userId))) {
      throw new HttpError("Subagent not found", { status: 404, code: "SUBAGENT_NOT_FOUND" })
    }
    return { userId, workspaceId, run }
  }

  return {
    /**
     * The run as the database holds it. The card normally needs no read — it is
     * drawn from its own event payload plus the in-window patches — but a
     * surface whose window cannot contain those patches (a deep link into a
     * finished subagent's thread) has nothing else to ask.
     */
    async get(req: Request, res: Response) {
      const { run } = await loadAccessible(req)
      res.json({
        subagent: {
          id: run.id,
          parentStreamId: run.parentStreamId,
          threadStreamId: run.threadStreamId,
          cardEventId: run.cardEventId,
          personaId: run.personaId,
          model: run.model,
          title: run.title,
          status: run.status,
          statusNote: run.statusNote,
          resultMessageId: run.resultMessageId,
          createdAt: run.createdAt.toISOString(),
          statusChangedAt: run.statusChangedAt.toISOString(),
        } satisfies SubagentSummary,
      })
    },

    async cancel(req: Request, res: Response) {
      const { userId, workspaceId, run } = await loadAccessible(req)

      const cancelled = await subagentService.cancel({
        workspaceId,
        id: run.id,
        parentStreamId: run.parentStreamId,
        cancelledBy: { actorId: userId, actorType: AuthorTypes.USER },
      })

      // `null` means the run already settled — the cancel lost the race. Report
      // which happened rather than erroring, so a double-click is harmless.
      res.json({ cancelled: cancelled !== null })
    },

    async requeue(req: Request, res: Response) {
      const { userId, workspaceId, run } = await loadAccessible(req)

      try {
        const reactivated = await subagentService.requeue({
          workspaceId,
          id: run.id,
          scopeStreamId: run.scopeStreamId,
          requeuedBy: { actorId: userId, actorType: AuthorTypes.USER },
        })
        res.json({ requeued: reactivated !== null })
      } catch (error) {
        if (error instanceof SubagentAlreadyActiveError) {
          throw new HttpError("Another subagent is already active in this stream", {
            status: 409,
            code: "SUBAGENT_ALREADY_ACTIVE",
          })
        }
        throw error
      }
    },
  }
}
