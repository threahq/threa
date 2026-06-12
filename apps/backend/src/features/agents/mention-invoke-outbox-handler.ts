import type { Pool } from "pg"
import { E2eStreamsRepository } from "../e2e-streams"
import { PersonaRepository } from "./persona-repository"
import { parseMessagePayload } from "../../lib/outbox"
import { AgentTriggers, AuthorTypes } from "@threa/types"
import { collectMentionSlugs } from "@threa/prosemirror"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"

export type MentionInvokeHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Handler that invokes personas when @mentioned in messages.
 *
 * Behavior by stream type:
 * - Channel: Agent creates a thread on the message, persona responds there
 * - Thread: Persona responds directly in the thread
 * - Scratchpad: Persona responds directly in the scratchpad
 * - DM: Persona responds directly in the DM
 *
 * Note: Thread creation for channels is handled by the PersonaAgent, not this handler.
 */
export class MentionInvokeHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: MentionInvokeHandlerConfig) {
    super(db, { listenerId: "mention-invoke", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType !== "message:created") {
      return
    }

    const payload = parseMessagePayload(event.payload)
    if (!payload) {
      logger.debug({ eventId: event.id.toString() }, "MentionInvokeHandler: malformed event, skipping")
      return
    }

    const { streamId, workspaceId, event: messageEvent } = payload

    // E2E streams: persona mentions in ciphertext are invisible to the
    // backend, and Phase 1 doesn't allow agent recipients anyway.
    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
      return
    }

    // Ignore persona messages (avoid infinite loops)
    if (messageEvent.actorType !== AuthorTypes.USER) {
      return
    }

    if (!messageEvent.actorId) {
      logger.warn({ streamId }, "MentionInvokeHandler: MEMBER message has no actorId, skipping")
      return
    }

    const triggeredBy = messageEvent.actorId

    // Mentions come from the canonical contentJson mention nodes (INV-58) —
    // produced by the editor's mention picker and by parseMarkdown on the
    // API path — not from a pattern over serialized markdown, so non-Latin
    // slugs invoke the same as ASCII ones (INV-54). Null contentJson (events
    // predating it) means "no structural mentions". Deduped: one job per
    // persona no matter how many times it's mentioned in the message.
    const contentJson = messageEvent.payload.contentJson
    const mentionSlugs = contentJson ? Array.from(new Set(collectMentionSlugs(contentJson))) : []
    if (mentionSlugs.length === 0) {
      return
    }

    for (const slug of mentionSlugs) {
      const persona = await PersonaRepository.findBySlug(this.db, slug, workspaceId)

      if (!persona || persona.status !== "active") {
        continue
      }

      logger.info(
        {
          streamId,
          messageId: messageEvent.payload.messageId,
          personaId: persona.id,
          personaSlug: persona.slug,
        },
        "Persona agent job dispatched (mention trigger)"
      )

      await this.jobQueue.send(JobQueues.PERSONA_AGENT, {
        workspaceId,
        streamId,
        messageId: messageEvent.payload.messageId,
        personaId: persona.id,
        triggeredBy,
        trigger: AgentTriggers.MENTION,
      })
    }
  }
}
