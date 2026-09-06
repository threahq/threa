import type { Pool } from "pg"
import { StreamRepository } from "../streams"
import { resolveDeliveryVerdict, TrustTiers } from "@threa/agent-runtime"
import { resolveSealingContext } from "../e2e-streams"
import { PersonaRepository } from "./persona-repository"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"
import { parseMessagePayload } from "../../lib/outbox"
import { AuthorTypes, CompanionModes, StreamTypes } from "@threa/types"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { SubagentRunRepository } from "../subagents"
import { MESSAGE_METADATA_COMMAND_KEY } from "../messaging"

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

    // A slash command the dispatcher persisted as a message: the dispatch already
    // made the invocation that runs it, so a turn here would answer "/spawn …" as
    // if it were an ordinary message.
    if (messageEvent.payload.metadata[MESSAGE_METADATA_COMMAND_KEY]) {
      return
    }

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

    // A live subagent thread answers regardless of companion mode: it may hang
    // off a CHANNEL, which has none, and the user answering the delegated model
    // there must reach it. The run's own persona is dispatched — never the
    // stream's — and the run going terminal reverts the thread to the ordinary
    // rules below. Only threads can host a run, so ordinary channel/scratchpad
    // traffic never pays for the lookup.
    const activeSubagent =
      stream.type === StreamTypes.THREAD
        ? await SubagentRunRepository.findActiveByThreadStreamId(this.db, workspaceId, streamId)
        : null

    let companionSource = stream
    let persona: Awaited<ReturnType<typeof PersonaRepository.findById>> = null

    if (activeSubagent) {
      persona = await PersonaRepository.findById(this.db, activeSubagent.personaId, workspaceId)
      if (!persona || persona.status !== "active") {
        logger.warn(
          { streamId, subagentId: activeSubagent.id, personaId: activeSubagent.personaId },
          "Active subagent run's persona is missing or inactive, skipping"
        )
        return
      }
    } else {
      // Resolve companion settings: for threads rooted in a scratchpad,
      // inherit the root scratchpad's companion mode and persona so
      // Ariadna responds in nested threads the same way she responds
      // in the scratchpad itself.
      if (stream.companionMode !== CompanionModes.ON && stream.rootStreamId) {
        const rootStream = await StreamRepository.findById(this.db, stream.rootStreamId)
        if (
          rootStream &&
          (rootStream.type === StreamTypes.SCRATCHPAD || rootStream.type === StreamTypes.ASIDE) &&
          rootStream.companionMode === CompanionModes.ON
        ) {
          companionSource = rootStream
        }
      }

      if (companionSource.companionMode !== CompanionModes.ON) {
        return
      }

      persona = companionSource.companionPersonaId
        ? await PersonaRepository.findById(this.db, companionSource.companionPersonaId!, companionSource.workspaceId)
        : null

      if (!persona || persona.status !== "active") {
        // Legacy NULL pointers (pre-pin-at-create rows) and archived picks fall
        // back to the built-in default. Deliberately NOT the user/workspace
        // default resolver — that runs at CREATE time only; re-resolving here
        // would switch a scratchpad's agent mid-run when a default changes.
        persona = await PersonaRepository.getSystemDefault(this.db, companionSource.workspaceId)
      }

      if (!persona) {
        logger.warn({ streamId }, "Companion mode on but no active persona available")
        return
      }
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

    // A message in a persona editor's test-drive scratchpad runs the editor's
    // candidate config, not the saved override (roadmap 7.1). Look the draft up
    // by the companion root (a thread rooted in the test scratchpad inherits it);
    // carrying `personaDraftId` makes the worker resolve `draft_test`.
    const testDraft = await PersonaConfigDraftRepository.findByTestStreamId(
      this.db,
      companionSource.workspaceId,
      companionSource.id
    )

    logger.info(
      { streamId, messageId: messageEvent.payload.messageId, personaId: persona.id, personaDraftId: testDraft?.id },
      "Persona agent job dispatched (companion mode)"
    )

    await this.jobQueue.send(JobQueues.PERSONA_AGENT, {
      workspaceId: stream.workspaceId,
      streamId,
      messageId: messageEvent.payload.messageId,
      personaId: persona.id,
      triggeredBy,
      ...(testDraft ? { personaDraftId: testDraft.id } : {}),
    })
  }
}
