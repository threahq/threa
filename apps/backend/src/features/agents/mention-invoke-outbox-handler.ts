import type { Pool } from "pg"
import { OutboxRepository } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"
import { PersonaRepository } from "./persona-repository"
import { parseMessagePayload } from "../../lib/outbox"
import { AgentTriggers, AuthorTypes } from "@threa/types"
import { extractMentionSlugs } from "./mention-extractor"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"

export interface MentionInvokeHandlerConfig {
  batchSize?: number
  debounceMs?: number
  maxWaitMs?: number
  lockDurationMs?: number
  refreshIntervalMs?: number
  maxRetries?: number
  baseBackoffMs?: number
}

const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 50,
  maxWaitMs: 200,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

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
export class MentionInvokeHandler implements OutboxHandler {
  readonly listenerId = "mention-invoke"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager, config?: MentionInvokeHandlerConfig) {
    this.db = db
    this.jobQueue = jobQueue
    this.batchSize = config?.batchSize ?? DEFAULT_CONFIG.batchSize

    this.cursorLock = new CursorLock({
      pool: db,
      listenerId: this.listenerId,
      lockDurationMs: config?.lockDurationMs ?? DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: config?.refreshIntervalMs ?? DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: config?.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: config?.baseBackoffMs ?? DEFAULT_CONFIG.baseBackoffMs,
      batchSize: this.batchSize,
    })

    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      config?.debounceMs ?? DEFAULT_CONFIG.debounceMs,
      config?.maxWaitMs ?? DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "MentionInvokeHandler debouncer error")
    )
  }

  async ensureListener(): Promise<void> {
    await ensureListenerFromLatest(this.db, this.listenerId)
  }

  handle(): void {
    this.debouncer.trigger()
  }

  private async processEvents(): Promise<void> {
    await this.cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
      const events = await OutboxRepository.fetchAfterId(this.db, cursor, this.batchSize, processedIds)

      if (events.length === 0) {
        return { status: "no_events" }
      }

      const seen: bigint[] = []

      try {
        for (const event of events) {
          if (event.eventType !== "message:created") {
            seen.push(event.id)
            continue
          }

          const payload = parseMessagePayload(event.payload)
          if (!payload) {
            logger.debug({ eventId: event.id.toString() }, "MentionInvokeHandler: malformed event, skipping")
            seen.push(event.id)
            continue
          }

          const { streamId, workspaceId, event: messageEvent } = payload

          // E2E streams: persona mentions in ciphertext are invisible to the
          // backend, and Phase 1 doesn't allow agent recipients anyway.
          if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
            seen.push(event.id)
            continue
          }

          // Ignore persona messages (avoid infinite loops)
          if (messageEvent.actorType !== AuthorTypes.USER) {
            seen.push(event.id)
            continue
          }

          if (!messageEvent.actorId) {
            logger.warn({ streamId }, "MentionInvokeHandler: MEMBER message has no actorId, skipping")
            seen.push(event.id)
            continue
          }

          const triggeredBy = messageEvent.actorId

          const mentionSlugs = extractMentionSlugs(messageEvent.payload.contentMarkdown)
          if (mentionSlugs.length === 0) {
            seen.push(event.id)
            continue
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

          seen.push(event.id)
        }

        return { status: "processed", processedIds: seen }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        if (seen.length > 0) {
          return { status: "error", error, processedIds: seen }
        }

        return { status: "error", error }
      }
    })
  }
}
