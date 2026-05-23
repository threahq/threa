import type { Request, Response } from "express"
import type { Pool } from "pg"
import { withClient } from "../../db"
import { AgentSessionRepository } from "./session-repository"
import { StreamRepository, StreamEventRepository } from "../streams"
import { StreamMemberRepository } from "../streams"
import { PersonaRepository } from "./persona-repository"
import { BotRepository } from "../public-api/bot-repository"
import type { AgentSessionWithSteps, AgentStepType } from "@threa/types"

interface Dependencies {
  pool: Pool
}

export function createAgentSessionHandlers({ pool }: Dependencies) {
  return {
    /**
     * GET /api/workspaces/:workspaceId/agent-sessions/:sessionId
     *
     * Returns the agent session with its steps and persona info.
     * User must have access to the session's stream.
     */
    async getSession(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { sessionId } = req.params

      const result = await withClient(pool, async (db) => {
        const session = await AgentSessionRepository.findById(db, sessionId)
        if (!session) {
          return { error: "Session not found", status: 404 }
        }

        const [stream, membership, persona, bot, steps] = await Promise.all([
          StreamRepository.findById(db, session.streamId),
          StreamMemberRepository.findByStreamAndMember(db, session.streamId, userId),
          PersonaRepository.findById(db, session.personaId, workspaceId),
          BotRepository.findById(db, workspaceId, session.personaId),
          AgentSessionRepository.findStepsBySession(db, sessionId),
        ])

        if (!stream || stream.workspaceId !== workspaceId) {
          return { error: "Session not found", status: 404 }
        }
        if (!membership) {
          return { error: "Not authorized to view this session", status: 403 }
        }
        let actor: { id: string; name: string; avatarUrl: string | null; avatarEmoji?: string | null } | null = null
        if (persona) {
          actor = { id: persona.id, name: persona.name, avatarUrl: null, avatarEmoji: persona.avatarEmoji }
        } else if (bot) {
          actor = { id: bot.id, name: bot.name, avatarUrl: bot.avatarUrl, avatarEmoji: bot.avatarEmoji ?? undefined }
        }
        if (!actor) {
          return { error: "Agent not found", status: 404 }
        }

        const relatedSessions = (
          await AgentSessionRepository.listByTriggerMessage(db, session.triggerMessageId)
        ).filter((relatedSession) => relatedSession.streamId === session.streamId)
        const sessionIds = [...new Set([session.id, ...relatedSessions.map((relatedSession) => relatedSession.id)])]
        const rerunContextBySessionId = await StreamEventRepository.listRerunContextBySessionIds(
          db,
          session.streamId,
          sessionIds
        )

        const mapSession = (s: typeof session) => ({
          id: s.id,
          streamId: s.streamId,
          personaId: s.personaId,
          triggerMessageId: s.triggerMessageId,
          triggerMessageRevision: s.triggerMessageRevision,
          supersedesSessionId: s.supersedesSessionId,
          rerunContext: rerunContextBySessionId.get(s.id) ?? null,
          status: s.status,
          currentStepType: s.currentStepType as AgentStepType | undefined,
          sentMessageIds: s.sentMessageIds,
          createdAt: s.createdAt.toISOString(),
          completedAt: s.completedAt?.toISOString(),
        })

        const response: AgentSessionWithSteps = {
          session: mapSession(session),
          steps: steps.map((step) => ({
            id: step.id,
            sessionId: step.sessionId,
            stepNumber: step.stepNumber,
            stepType: step.stepType,
            content: step.content as string | undefined,
            sources: step.sources ?? undefined,
            messageId: step.messageId ?? undefined,
            tokensUsed: step.tokensUsed ?? undefined,
            duration:
              step.completedAt && step.startedAt ? step.completedAt.getTime() - step.startedAt.getTime() : undefined,
            startedAt: step.startedAt.toISOString(),
            completedAt: step.completedAt?.toISOString(),
          })),
          persona: actor,
          relatedSessions: relatedSessions.map(mapSession),
        }

        return { data: response }
      })

      if (result.error) {
        return res.status(result.status).json({ error: result.error })
      }

      res.json(result.data)
    },
  }
}
