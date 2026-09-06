import type { Pool } from "pg"
import { E2eStreamsRepository } from "../e2e-streams"
import { PersonaRepository } from "./persona-repository"
import { parseMessagePayload } from "../../lib/outbox"
import { AgentTriggers, AuthorTypes } from "@threa/types"
import { collectMentionActorRefs } from "@threa/prosemirror"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { MESSAGE_METADATA_COMMAND_KEY } from "../messaging"

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

    // A slash command the dispatcher persisted as a message: the dispatch already
    // made the invocation that runs it, so a turn here would answer "/spawn …" as
    // if it were an ordinary message.
    if (messageEvent.payload.metadata[MESSAGE_METADATA_COMMAND_KEY]) {
      return
    }

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

    // Mention nodes carry a resolved actor id as the authoritative reference
    // (INV-64) — the ingestion resolver has already rewritten markdown-path
    // slugs to ids, so we select by id and never by slug (INV-54: id-based
    // dispatch is language-agnostic). Null contentJson (events predating it)
    // means "no structural mentions". Deduped by actorId upstream: one job per
    // persona no matter how many times it's mentioned in the message.
    const contentJson = messageEvent.payload.contentJson
    const personaIds = contentJson
      ? collectMentionActorRefs(contentJson)
          .filter((ref) => ref.actorType === "persona")
          .map((ref) => ref.actorId)
      : []
    if (personaIds.length === 0) {
      return
    }

    const personas = await PersonaRepository.findByIds(this.db, personaIds, workspaceId)

    for (const persona of personas) {
      if (persona.status !== "active") {
        continue
      }

      // A personal persona (user-scoped-personas) is invisible to everyone but
      // its owner and only they may invoke it. `findByIds` is workspace-scoped
      // (it serves display of already-authorized pins), so an id-form mention —
      // which can arrive pre-resolved from a rich client or the API, bypassing
      // slug-side viewer filtering — is gated here. `triggeredBy` is the
      // author's user id (actorType is USER, checked above); a persona mentioned
      // by anyone else is silently skipped while other mentioned personas in the
      // same message still dispatch.
      if (persona.managedBy === "user" && persona.ownerUserId !== triggeredBy) {
        logger.debug(
          { streamId, personaId: persona.id, ownerUserId: persona.ownerUserId, triggeredBy },
          "MentionInvokeHandler: skipping personal persona mentioned by a non-owner"
        )
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
