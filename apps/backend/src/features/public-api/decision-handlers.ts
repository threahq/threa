import type { Request, Response } from "express"
import { HttpError } from "@threahq/backend-common"
import { validateRequest } from "../../lib/validation"
import { serializeDecisionRequest, type DecisionRequestRecord, type DecisionService } from "../decisions"
import { createDecisionSchema } from "./schemas"

interface DecisionPublicApiDeps {
  decisionService: DecisionService
}

/**
 * Public API for decision requests (Hermes): the runtime's escape hatch when it
 * hits a call only its human can make. Bot keys only — a decision is opened by
 * something that is running on the stream, and a user key has no session to
 * block. Reads and cancels are scoped to the bot that opened the card, so one
 * workspace bot cannot withdraw another's question.
 */
export function createDecisionPublicApi({ decisionService }: DecisionPublicApiDeps) {
  function requireBotId(req: Request): string {
    const botId = req.botApiKey?.botId
    if (!botId) {
      throw new HttpError("A decision is opened by a running bot; use a bot key", {
        status: 400,
        code: "USER_KEY_CANNOT_REQUEST_DECISION",
      })
    }
    return botId
  }

  async function loadOwnDecision(req: Request, botId: string): Promise<DecisionRequestRecord> {
    const decision = await decisionService.getById({ workspaceId: req.workspaceId!, id: req.params.id! })
    if (!decision || decision.requesterBotId !== botId) {
      throw new HttpError("Decision not found", { status: 404, code: "NOT_FOUND" })
    }
    return decision
  }

  return {
    async createDecision(req: Request, res: Response) {
      const botId = requireBotId(req)
      const body = validateRequest(createDecisionSchema, req.body)
      const decision = await decisionService.request({
        workspaceId: req.workspaceId!,
        streamId: req.params.streamId!,
        botId,
        runtimeSessionId: body.runtimeSessionId,
        invocationId: body.invocationId,
        title: body.title,
        bodyMarkdown: body.bodyMarkdown,
        options: body.options,
        allowNote: body.allowNote,
        externalRef: body.externalRef,
        expiresAt: body.expiresInMs === undefined ? undefined : new Date(Date.now() + body.expiresInMs),
      })
      res.json({ data: serializeDecisionRequest(decision) })
    },

    async cancelDecision(req: Request, res: Response) {
      const botId = requireBotId(req)
      const decision = await loadOwnDecision(req, botId)
      const cancelled = await decisionService.cancel({ workspaceId: decision.workspaceId, id: decision.id })
      res.json({ data: serializeDecisionRequest(cancelled ?? decision) })
    },

    async getDecision(req: Request, res: Response) {
      const botId = requireBotId(req)
      res.json({ data: serializeDecisionRequest(await loadOwnDecision(req, botId)) })
    },
  }
}
