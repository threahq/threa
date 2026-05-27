import type { Pool } from "pg"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { PersonaRepository } from "./persona-repository"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"
import { parseMessagePayload } from "../../lib/outbox"
import { ARIADNE_AGENT_ID } from "./built-in-agents"
import { AuthorTypes, CompanionModes, E2eInvitedAgentKinds, StreamTypes } from "@threa/types"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"

export interface CompanionHandlerConfig {
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
 * Handler that dispatches agentic jobs for messages in streams
 * with companion mode enabled.
 *
 * Flow:
 * 1. Message arrives (via outbox)
 * 2. Check if it's a user message (not persona response)
 * 3. Check if stream has companion mode = 'on'
 * 4. Dispatch queue job for persona agent
 *
 * Uses time-based cursor locking for exclusive access without
 * holding database connections during processing.
 */
export class CompanionHandler implements OutboxHandler {
  readonly listenerId = "companion"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager, config?: CompanionHandlerConfig) {
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
      (err) => logger.error({ err, listenerId: this.listenerId }, "CompanionHandler debouncer error")
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
            logger.debug({ eventId: event.id.toString() }, "CompanionHandler: malformed event, skipping")
            seen.push(event.id)
            continue
          }

          const { streamId, workspaceId, event: messageEvent } = payload

          // E2E streams: the plaintext companion path can't see ciphertext,
          // so fall through to the enclave dispatch when the owner has
          // invited the enclave persona; otherwise skip without inspecting
          // the message (no plaintext Ariadne reply possible).
          const e2eRow = await E2eStreamsRepository.getByStreamId(this.db, workspaceId, streamId)
          if (e2eRow) {
            if (e2eRow.invitedAgentKind !== E2eInvitedAgentKinds.ENCLAVE) {
              seen.push(event.id)
              continue
            }
            if (messageEvent.actorType !== AuthorTypes.USER) {
              seen.push(event.id)
              continue
            }
            if (!messageEvent.actorId) {
              logger.warn({ streamId }, "CompanionHandler: E2E enclave message has no actorId, skipping")
              seen.push(event.id)
              continue
            }
            logger.info(
              { streamId, messageId: messageEvent.payload.messageId, personaId: ARIADNE_AGENT_ID },
              "Enclave persona agent job dispatched (always-on companion in E2E)"
            )
            await this.jobQueue.send(JobQueues.ENCLAVE_PERSONA_AGENT, {
              workspaceId,
              streamId,
              messageId: messageEvent.payload.messageId,
              personaId: ARIADNE_AGENT_ID,
              triggeredBy: messageEvent.actorId,
            })
            seen.push(event.id)
            continue
          }

          // Ignore persona messages (avoid infinite loops)
          if (messageEvent.actorType !== AuthorTypes.USER) {
            seen.push(event.id)
            continue
          }

          if (!messageEvent.actorId) {
            logger.warn({ streamId }, "CompanionHandler: MEMBER message has no actorId, skipping")
            seen.push(event.id)
            continue
          }

          const triggeredBy = messageEvent.actorId

          const stream = await StreamRepository.findById(this.db, streamId)
          if (!stream) {
            logger.warn({ streamId }, "CompanionHandler: stream not found")
            seen.push(event.id)
            continue
          }

          // Resolve companion settings: for threads rooted in a scratchpad,
          // inherit the root scratchpad's companion mode and persona so
          // Ariadna responds in nested threads the same way she responds
          // in the scratchpad itself.
          let companionSource = stream
          if (stream.companionMode !== CompanionModes.ON && stream.rootStreamId) {
            const rootStream = await StreamRepository.findById(this.db, stream.rootStreamId)
            if (
              rootStream &&
              rootStream.type === StreamTypes.SCRATCHPAD &&
              rootStream.companionMode === CompanionModes.ON
            ) {
              companionSource = rootStream
            }
          }

          if (companionSource.companionMode !== CompanionModes.ON) {
            seen.push(event.id)
            continue
          }

          let persona = companionSource.companionPersonaId
            ? await PersonaRepository.findById(
                this.db,
                companionSource.companionPersonaId!,
                companionSource.workspaceId
              )
            : null

          if (!persona || persona.status !== "active") {
            persona = await PersonaRepository.getSystemDefault(this.db, companionSource.workspaceId)
          }

          if (!persona) {
            logger.warn({ streamId }, "Companion mode on but no active persona available")
            seen.push(event.id)
            continue
          }

          const lastSession = await AgentSessionRepository.findLatestByStream(this.db, streamId)

          if (lastSession) {
            const messageSequence = BigInt(messageEvent.sequence)

            // If a session is still running or pending, it will pick up new messages
            // via check_new_messages node in the graph — don't dispatch duplicate jobs
            if (lastSession.status === SessionStatuses.PENDING || lastSession.status === SessionStatuses.RUNNING) {
              logger.debug(
                {
                  streamId,
                  messageId: messageEvent.payload.messageId,
                  sessionId: lastSession.id,
                  sessionStatus: lastSession.status,
                },
                "Session already active for stream, new message will be handled in-flight"
              )
              seen.push(event.id)
              continue
            }

            if (lastSession.status === SessionStatuses.COMPLETED && lastSession.lastSeenSequence) {
              if (messageSequence <= lastSession.lastSeenSequence) {
                logger.debug(
                  {
                    streamId,
                    messageId: messageEvent.payload.messageId,
                    messageSequence: messageSequence.toString(),
                    lastSeenSequence: lastSession.lastSeenSequence.toString(),
                  },
                  "Message already seen by previous session, skipping"
                )
                seen.push(event.id)
                continue
              }
            }
          }

          logger.info(
            { streamId, messageId: messageEvent.payload.messageId, personaId: persona.id },
            "Persona agent job dispatched (companion mode)"
          )

          await this.jobQueue.send(JobQueues.PERSONA_AGENT, {
            workspaceId: stream.workspaceId,
            streamId,
            messageId: messageEvent.payload.messageId,
            personaId: persona.id,
            triggeredBy,
          })

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
