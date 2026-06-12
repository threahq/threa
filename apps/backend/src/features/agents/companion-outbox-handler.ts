import type { Pool } from "pg"
import { StreamRepository } from "../streams"
import { resolveDeliveryVerdict, TrustTiers } from "@threa/agent-runtime"
import { resolveSealingContext } from "../e2e-streams"
import { PersonaRepository } from "./persona-repository"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"
import { parseMessagePayload } from "../../lib/outbox"
import { AuthorTypes, CompanionModes, StreamTypes } from "@threa/types"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"

export type CompanionHandlerConfig = DebouncedOutboxHandlerConfig

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
export class CompanionHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: CompanionHandlerConfig) {
    super(db, { listenerId: "companion", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType !== "message:created") {
      return
    }

    const payload = parseMessagePayload(event.payload)
    if (!payload) {
      logger.debug({ eventId: event.id.toString() }, "CompanionHandler: malformed event, skipping")
      return
    }

    const { streamId, workspaceId, event: messageEvent } = payload

    // The companion is an in-process plaintext driver: it only takes
    // turns the delivery verdict says may be minted plaintext. E2E
    // streams come back denied (no grant by construction — Ariadne
    // can't see ciphertext) and route through the enclave instead.
    const sealing = await resolveSealingContext(this.db, {
      workspaceId,
      streamId,
      actor: { kind: "companion" },
    })
    const verdict = resolveDeliveryVerdict({ trust: TrustTiers.FIRST_PARTY_INPROC, sealing })
    if (verdict.delivery !== "plaintext") {
      return
    }

    // Ignore persona messages (avoid infinite loops)
    if (messageEvent.actorType !== AuthorTypes.USER) {
      return
    }

    if (!messageEvent.actorId) {
      logger.warn({ streamId }, "CompanionHandler: MEMBER message has no actorId, skipping")
      return
    }

    const triggeredBy = messageEvent.actorId

    const stream = await StreamRepository.findById(this.db, streamId)
    if (!stream) {
      logger.warn({ streamId }, "CompanionHandler: stream not found")
      return
    }

    // Resolve companion settings: for threads rooted in a scratchpad,
    // inherit the root scratchpad's companion mode and persona so
    // Ariadna responds in nested threads the same way she responds
    // in the scratchpad itself.
    let companionSource = stream
    if (stream.companionMode !== CompanionModes.ON && stream.rootStreamId) {
      const rootStream = await StreamRepository.findById(this.db, stream.rootStreamId)
      if (rootStream && rootStream.type === StreamTypes.SCRATCHPAD && rootStream.companionMode === CompanionModes.ON) {
        companionSource = rootStream
      }
    }

    if (companionSource.companionMode !== CompanionModes.ON) {
      return
    }

    let persona = companionSource.companionPersonaId
      ? await PersonaRepository.findById(this.db, companionSource.companionPersonaId!, companionSource.workspaceId)
      : null

    if (!persona || persona.status !== "active") {
      persona = await PersonaRepository.getSystemDefault(this.db, companionSource.workspaceId)
    }

    if (!persona) {
      logger.warn({ streamId }, "Companion mode on but no active persona available")
      return
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
        return
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
          return
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
  }
}
