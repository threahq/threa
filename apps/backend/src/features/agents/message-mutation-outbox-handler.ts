import type { Pool } from "pg"
import { AuthorTypes, type AgentSessionRerunContext } from "@threa/types"
import { withTransaction } from "../../db"
import { eventId } from "../../lib/id"
import { logger } from "../../lib/logger"
import {
  CursorLock,
  ensureListenerFromLatest,
  DebounceWithMaxWait,
  serializeBigInt,
  type ProcessResult,
} from "@threa/backend-common"
import { OutboxRepository } from "../../lib/outbox"
import type { OutboxHandler } from "../../lib/outbox"
import { JobQueues, type QueueManager } from "../../lib/queue"
import type { EventService } from "../messaging"
import { MessageVersionRepository } from "../messaging"
import { StreamEventRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "./session-repository"

export interface AgentMessageMutationHandlerConfig {
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

function rerunQueueMessageId(sessionId: string): string {
  return `queue_rerun_${sessionId}`
}

interface NormalizedMessageEditedPayload {
  workspaceId: string
  streamId: string
  messageId: string
  actorId: string | null
  actorType: string | null
  sequence: bigint | null
  editedContentMarkdown: string | null
}

interface NormalizedMessageDeletedPayload {
  workspaceId: string
  messageId: string
}

function parseMessageEditedPayload(payload: unknown): NormalizedMessageEditedPayload | null {
  if (!payload || typeof payload !== "object") return null

  const p = payload as Record<string, unknown>
  if (typeof p.workspaceId !== "string" || typeof p.streamId !== "string") return null

  const event = p.event as Record<string, unknown> | undefined
  if (!event || typeof event !== "object") return null

  const eventPayload = event.payload as Record<string, unknown> | undefined
  if (!eventPayload || typeof eventPayload !== "object" || typeof eventPayload.messageId !== "string") {
    return null
  }

  const sequence = parseSequence(event.sequence)

  return {
    workspaceId: p.workspaceId,
    streamId: p.streamId,
    messageId: eventPayload.messageId,
    actorId: typeof event.actorId === "string" ? event.actorId : null,
    actorType: typeof event.actorType === "string" ? event.actorType : null,
    sequence,
    editedContentMarkdown: typeof eventPayload.contentMarkdown === "string" ? eventPayload.contentMarkdown : null,
  }
}

function toContextPreview(content: string | null | undefined): string | null {
  if (typeof content !== "string") return null
  const trimmed = content.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length <= 240) return trimmed
  return `${trimmed.slice(0, 237)}...`
}

function parseSequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value)
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value)
    } catch {
      return null
    }
  }
  return null
}

function parseMessageDeletedPayload(payload: unknown): NormalizedMessageDeletedPayload | null {
  if (!payload || typeof payload !== "object") return null

  const p = payload as Record<string, unknown>
  if (typeof p.workspaceId !== "string" || typeof p.messageId !== "string") return null

  return {
    workspaceId: p.workspaceId,
    messageId: p.messageId,
  }
}

/**
 * Handles message edits/deletions that affect existing agent sessions.
 *
 * Rules:
 * - Invoking message deleted (any time): mark related sessions as deleted and delete their sent messages.
 * - Invoking message edited after a terminal run: mark latest session for that trigger as superseded and enqueue rerun.
 * - Referenced message edited after a terminal run: supersede latest stream session and rerun using its trigger message.
 *   The rerun reconciles prior sent messages (edit/delete) on completion.
 * - In-flight edit/delete reconsideration is handled by runtime context polling (no extra dispatch here).
 */
export class AgentMessageMutationHandler implements OutboxHandler {
  readonly listenerId = "agent-message-mutations"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly eventService: EventService
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(
    db: Pool,
    jobQueue: QueueManager,
    eventService: EventService,
    config?: AgentMessageMutationHandlerConfig
  ) {
    this.db = db
    this.jobQueue = jobQueue
    this.eventService = eventService
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
      (err) => logger.error({ err, listenerId: this.listenerId }, "AgentMessageMutationHandler debouncer error")
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
          if (event.eventType === "message:edited") {
            const payload = parseMessageEditedPayload(event.payload)
            if (payload) {
              // E2E streams: Phase 1 doesn't allow agent recipients, so there
              // are no sessions to rerun. Ciphertext edits are also invisible
              // to the backend, so skip without inspecting the message.
              if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) {
                seen.push(event.id)
                continue
              }
              await this.handleInvokingMessageEdited(payload, event.createdAt)
            }
          } else if (event.eventType === "message:deleted") {
            const payload = parseMessageDeletedPayload(event.payload)
            if (payload) {
              // E2E streams: no agent sessions exist for E2E streams in Phase 1
              // (agents not allowed), so the session lookup is a natural no-op.
              // We still call through; the repository returns no rows.
              await this.handleInvokingMessageDeleted(payload)
            }
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

  private async handleInvokingMessageEdited(payload: NormalizedMessageEditedPayload, occurredAt: Date): Promise<void> {
    if (payload.actorType === AuthorTypes.PERSONA) {
      return
    }

    const latestSession = await AgentSessionRepository.findByTriggerMessage(this.db, payload.messageId)
    if (latestSession) {
      await this.handleTriggerMessageEdit(payload, occurredAt, latestSession)
      return
    }

    await this.handleReferencedMessageEdited(payload, occurredAt)
  }

  private async handleTriggerMessageEdit(
    payload: NormalizedMessageEditedPayload,
    occurredAt: Date,
    latestSession: AgentSession
  ): Promise<void> {
    if (this.shouldSkipBySessionStatus(latestSession)) {
      return
    }

    if (this.completedBeforeEdit(latestSession, occurredAt)) {
      logger.info(
        {
          sessionId: latestSession.id,
          triggerMessageId: payload.messageId,
          completedAt: latestSession.completedAt?.toISOString(),
          editedAt: occurredAt.toISOString(),
        },
        "Skipping rerun because invoking edit occurred before session completion"
      )
      return
    }

    const currentRevision = await MessageVersionRepository.getCurrentRevision(this.db, payload.messageId)
    if (currentRevision === null) return

    if (latestSession.triggerMessageRevision !== null && latestSession.triggerMessageRevision >= currentRevision) {
      return
    }

    const editContext = await this.getEditContext(payload.messageId, payload.editedContentMarkdown)

    await this.supersedeAndDispatchRerun({
      session: latestSession,
      workspaceId: payload.workspaceId,
      rerunMessageId: payload.messageId,
      triggeredBy: payload.actorId,
      rerunContext: {
        cause: "invoking_message_edited",
        editedMessageId: payload.messageId,
        editedMessageRevision: currentRevision,
        editedMessageBefore: editContext.before,
        editedMessageAfter: editContext.after,
      },
      supersedeReason: "Superseded by invoking message edit",
      logFields: {
        triggerMessageId: payload.messageId,
        triggerMessageRevision: currentRevision,
        streamId: latestSession.streamId,
      },
      logMessage: "Superseded session due to invoking message edit and dispatched rerun",
    })
  }

  private async handleReferencedMessageEdited(
    payload: NormalizedMessageEditedPayload,
    occurredAt: Date
  ): Promise<void> {
    const latestSession = await AgentSessionRepository.findLatestByStream(this.db, payload.streamId)
    if (!latestSession) return
    if (latestSession.triggerMessageId === payload.messageId) return
    if (this.shouldSkipBySessionStatus(latestSession)) return

    if (this.completedBeforeEdit(latestSession, occurredAt)) {
      return
    }

    // Skip if the edited message was never in the agent's context window.
    // contextMessageIds tracks exactly which messages the agent saw.
    // For pre-migration sessions without context IDs, fall back to the
    // sequence-based heuristic as a coarse upper-bound guard.
    if (latestSession.contextMessageIds.length > 0) {
      if (!latestSession.contextMessageIds.includes(payload.messageId)) {
        return
      }
    } else if (
      payload.sequence !== null &&
      latestSession.lastSeenSequence !== null &&
      payload.sequence > latestSession.lastSeenSequence
    ) {
      return
    }

    const editContext = await this.getEditContext(payload.messageId, payload.editedContentMarkdown)

    await this.supersedeAndDispatchRerun({
      session: latestSession,
      workspaceId: payload.workspaceId,
      rerunMessageId: latestSession.triggerMessageId,
      triggeredBy: payload.actorId,
      rerunContext: {
        cause: "referenced_message_edited",
        editedMessageId: payload.messageId,
        editedMessageBefore: editContext.before,
        editedMessageAfter: editContext.after,
      },
      supersedeReason: "Superseded by referenced message edit",
      logFields: {
        editedMessageId: payload.messageId,
        editedMessageSequence: payload.sequence?.toString() ?? null,
        triggerMessageId: latestSession.triggerMessageId,
        streamId: latestSession.streamId,
      },
      logMessage: "Superseded session due to referenced message edit and dispatched rerun",
    })
  }

  private shouldSkipBySessionStatus(session: AgentSession): boolean {
    return (
      session.status === SessionStatuses.RUNNING ||
      session.status === SessionStatuses.PENDING ||
      session.status === SessionStatuses.DELETED
    )
  }

  private completedBeforeEdit(session: AgentSession, occurredAt: Date): boolean {
    return session.status === SessionStatuses.COMPLETED && !!session.completedAt && session.completedAt > occurredAt
  }

  private async getEditContext(
    messageId: string,
    editedContentMarkdown: string | null
  ): Promise<{ before: string | null; after: string | null }> {
    const after = toContextPreview(editedContentMarkdown)
    try {
      const previousVersion = await MessageVersionRepository.findLatestByMessageId(this.db, messageId)
      return {
        before: toContextPreview(previousVersion?.contentMarkdown ?? null),
        after,
      }
    } catch (err) {
      logger.warn({ err, messageId }, "Failed to load previous message version for rerun context")
      return { before: null, after }
    }
  }

  private async supersedeAndDispatchRerun(params: {
    session: AgentSession
    workspaceId: string
    rerunMessageId: string
    triggeredBy: string | null
    rerunContext: AgentSessionRerunContext
    supersedeReason: string
    logFields: Record<string, unknown>
    logMessage: string
  }): Promise<void> {
    const { session, workspaceId, rerunMessageId, triggeredBy, rerunContext, supersedeReason, logFields, logMessage } =
      params

    const superseded =
      session.status === SessionStatuses.SUPERSEDED
        ? session
        : await AgentSessionRepository.updateStatus(this.db, session.id, SessionStatuses.SUPERSEDED, {
            error: supersedeReason,
            onlyIfStatusIn: [SessionStatuses.COMPLETED, SessionStatuses.FAILED],
          })
    if (!superseded) return

    await this.jobQueue.send(
      JobQueues.PERSONA_AGENT,
      {
        workspaceId,
        streamId: superseded.streamId,
        messageId: rerunMessageId,
        personaId: superseded.personaId,
        triggeredBy: triggeredBy ?? "system",
        supersedesSessionId: superseded.id,
        rerunContext,
      },
      {
        messageId: rerunQueueMessageId(superseded.id),
      }
    )

    logger.info({ sessionId: superseded.id, ...logFields }, logMessage)
  }

  private async handleInvokingMessageDeleted(payload: NormalizedMessageDeletedPayload): Promise<void> {
    const sessions = await AgentSessionRepository.listByTriggerMessage(this.db, payload.messageId)
    if (sessions.length === 0) return

    for (const session of sessions) {
      const deletedAt = await this.markSessionDeleted(session, payload.workspaceId)

      await this.deleteSessionMessages(session, payload.workspaceId)

      if (!deletedAt) continue

      logger.info(
        {
          sessionId: session.id,
          triggerMessageId: payload.messageId,
          streamId: session.streamId,
        },
        "Deleted session and sent messages because invoking message was deleted"
      )
    }
  }

  private async markSessionDeleted(session: AgentSession, workspaceId: string): Promise<string | null> {
    if (session.status === SessionStatuses.DELETED) {
      return session.completedAt?.toISOString() ?? null
    }

    return withTransaction(this.db, async (db) => {
      const updated = await AgentSessionRepository.updateStatus(db, session.id, SessionStatuses.DELETED, {
        error: "Invoking message deleted",
      })
      if (!updated) return null

      const deletedAtIso = updated.completedAt?.toISOString() ?? new Date().toISOString()

      const streamEvent = await StreamEventRepository.insert(db, {
        id: eventId(),
        streamId: updated.streamId,
        eventType: "agent_session:deleted",
        payload: {
          sessionId: updated.id,
          deletedAt: deletedAtIso,
        },
        actorId: updated.personaId,
        actorType: AuthorTypes.PERSONA,
      })

      await OutboxRepository.insert(db, "agent_session:deleted", {
        workspaceId,
        streamId: updated.streamId,
        event: serializeBigInt(streamEvent),
      })

      return deletedAtIso
    })
  }

  private async deleteSessionMessages(session: AgentSession, workspaceId: string): Promise<void> {
    let messageIds = [...session.sentMessageIds]
    try {
      const eventMessageIds = await StreamEventRepository.listMessageIdsBySession(this.db, session.streamId, session.id)
      messageIds = [...new Set([...messageIds, ...eventMessageIds])]
    } catch (err) {
      logger.error({ err, sessionId: session.id }, "Failed loading session messages from stream events")
    }

    for (const sentMessageId of messageIds) {
      try {
        await this.eventService.deleteMessage({
          workspaceId,
          streamId: session.streamId,
          messageId: sentMessageId,
          actorId: session.personaId,
          actorType: AuthorTypes.PERSONA,
        })
      } catch (err) {
        logger.error({ err, sessionId: session.id, sentMessageId }, "Failed deleting sent message for session")
      }
    }
  }
}
