import type { Pool } from "pg"
import { CompanionModes } from "@threahq/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { onboardingGreetingId, queueId } from "../../lib/id"
import { JobQueues, enqueueQueuedJob, type PersonaAgentJobData } from "../../lib/queue"
import { PersonaRepository } from "../agents"
import { StreamRepository, type StreamService } from "../streams"

/**
 * `uniqueness_key` of a user's "Meet Ariadne" scratchpad. One per user per
 * workspace; its existence is the checklist item's done signal.
 */
export function onboardingStreamUniquenessKey(userId: string): string {
  return `onboarding:meet-ariadne:${userId}`
}

interface Dependencies {
  pool: Pool
  streamService: Pick<StreamService, "createOrFindScratchpadInTransaction">
}

export class OnboardingService {
  private readonly pool: Pool
  private readonly streamService: Dependencies["streamService"]

  constructor({ pool, streamService }: Dependencies) {
    this.pool = pool
    this.streamService = streamService
  }

  async findMeetAriadneStreamId(workspaceId: string, userId: string): Promise<string | null> {
    const stream = await StreamRepository.findByUniquenessKey(
      this.pool,
      workspaceId,
      onboardingStreamUniquenessKey(userId)
    )
    return stream?.id ?? null
  }

  /**
   * Find or create the user's Ariadne scratchpad. Only the call that mints the
   * stream enqueues the greeting turn, in the same transaction, so a second
   * click or a concurrent one returns the same stream with no second greeting.
   */
  async meetAriadne(params: { workspaceId: string; userId: string }): Promise<{ streamId: string }> {
    const { workspaceId, userId } = params

    return withTransaction(this.pool, async (client) => {
      const ariadne = await PersonaRepository.getSystemDefault(client, workspaceId)
      if (!ariadne) {
        throw new HttpError("Ariadne is not available in this workspace", {
          status: 503,
          code: "ARIADNE_PERSONA_MISSING",
        })
      }

      const { stream, created } = await this.streamService.createOrFindScratchpadInTransaction(client, {
        workspaceId,
        createdBy: userId,
        companionMode: CompanionModes.ON,
        companionPersonaId: ariadne.id,
        uniquenessKey: onboardingStreamUniquenessKey(userId),
        onboarding: true,
      })

      if (created) {
        const payload: PersonaAgentJobData = {
          workspaceId,
          streamId: stream.id,
          messageId: onboardingGreetingId(),
          personaId: ariadne.id,
          triggeredBy: userId,
          onboardingGreeting: true,
        }
        await enqueueQueuedJob(client, {
          queueName: JobQueues.PERSONA_AGENT,
          workspaceId,
          payload,
          processAfter: new Date(),
          generateId: queueId,
        })
      }

      return { streamId: stream.id }
    })
  }
}
