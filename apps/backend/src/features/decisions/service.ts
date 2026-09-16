import type { Pool } from "pg"
import type { Querier } from "../../db"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { decisionRequestId, eventId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import {
  AuthorTypes,
  DecisionRequestStatuses,
  type DecisionOption,
  type DecisionRequestKind,
  type DecisionRequestedEventPayload,
  type DecisionResolution,
  type DecisionResolvedEventPayload,
} from "@threahq/types"
import { BotInvocationRepository, BotRuntimeSessionLinkRepository } from "../bot-runtimes"
import { E2eStreamsRepository } from "../e2e-streams"
import { checkStreamAccess, StreamEventRepository, StreamRepository } from "../streams"
import { DecisionRequestRepository, serializeDecisionRequest, type DecisionRequestRecord } from "./repository"

/**
 * The bot-side stream gate, satisfied by `BotChannelService` — injected as a
 * narrow interface so the service stays unit-testable (INV-12).
 */
export interface BotStreamAccessChecker {
  isStreamActionableForBot(workspaceId: string, botId: string, streamId: string): Promise<boolean>
}

interface DecisionServiceDeps {
  pool: Pool
  botChannelService: BotStreamAccessChecker
}

export interface RequestDecisionParams {
  workspaceId: string
  streamId: string
  botId: string
  runtimeSessionId?: string
  invocationId?: string
  kind: DecisionRequestKind
  title: string
  bodyMarkdown?: string
  options: DecisionOption[]
  allowNote: boolean
  externalRef?: string
  expiresAt?: Date
}

export interface ResolveDecisionParams {
  workspaceId: string
  id: string
  userId: string
  optionId: string
  note?: string
  version: number
}

/**
 * Lifecycle owner for decision requests (Hermes): a bot runtime hits a call it
 * cannot make, posts the question as a card on the stream, and blocks on the
 * answer. Every transition writes the row and appends its timeline event in one
 * transaction (INV-4/7) — `decision:requested` is the card, and
 * resolve/cancel/expire each append a `decision:resolved` patch onto it. When
 * the requester named a runtime session, the same transaction also queues the
 * bot-plane push that unblocks it.
 *
 * Concurrency: every write CASes on the row's `version` (INV-66), so one
 * resolver wins and a second sees the answer that landed.
 */
export class DecisionService {
  private readonly pool: Pool
  private readonly botChannelService: BotStreamAccessChecker

  constructor(deps: DecisionServiceDeps) {
    this.pool = deps.pool
    this.botChannelService = deps.botChannelService
  }

  /**
   * Open a decision on behalf of a bot. Two gates: the bot must be able to act
   * on the stream at all, and it must currently be running there — a live
   * session link or an in-flight invocation. A bot with no work in progress has
   * nobody waiting on the answer, so its card would be unanswerable noise.
   */
  async request(params: RequestDecisionParams): Promise<DecisionRequestRecord> {
    if (!(await this.botChannelService.isStreamActionableForBot(params.workspaceId, params.botId, params.streamId))) {
      throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
    }

    return withTransaction(this.pool, async (client) => {
      const stream = await StreamRepository.findByIdForWorkspace(client, params.streamId, params.workspaceId)
      if (!stream) {
        throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
      }
      const rootStreamId = stream.rootStreamId ?? stream.id

      if (await E2eStreamsRepository.isE2eStream(client, params.workspaceId, rootStreamId)) {
        throw new HttpError("Decisions on an end-to-end encrypted stream are not supported yet", {
          status: 400,
          code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
        })
      }

      const invocation = params.invocationId
        ? await BotInvocationRepository.findLiveClaimedForBot(client, {
            workspaceId: params.workspaceId,
            botId: params.botId,
            invocationId: params.invocationId,
          })
        : null
      if (params.invocationId && (!invocation || invocation.rootStreamId !== rootStreamId)) {
        throw new HttpError("The named invocation is not this bot's in-flight work on this stream", {
          status: 409,
          code: "DECISION_REQUESTER_NOT_ACTIVE",
        })
      }

      if (
        invocation?.claimedRuntimeSessionId &&
        params.runtimeSessionId &&
        invocation.claimedRuntimeSessionId !== params.runtimeSessionId
      ) {
        throw new HttpError("The named runtime session did not claim this invocation", {
          status: 409,
          code: "DECISION_REQUESTER_NOT_ACTIVE",
        })
      }

      const link = await BotRuntimeSessionLinkRepository.findActiveByStream(client, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        rootStreamId,
        activeStreamId: params.streamId,
      })
      if (link && params.runtimeSessionId && link.runtimeSessionId !== params.runtimeSessionId) {
        throw new HttpError("The named runtime session is not linked to this stream", {
          status: 409,
          code: "DECISION_REQUESTER_NOT_ACTIVE",
        })
      }
      if (!link && !invocation) {
        throw new HttpError("This bot has no running session or in-flight invocation on this stream", {
          status: 409,
          code: "DECISION_REQUESTER_NOT_ACTIVE",
        })
      }

      const runtimeSessionId =
        params.runtimeSessionId ?? link?.runtimeSessionId ?? invocation?.claimedRuntimeSessionId ?? null
      // The answer is pushed to the requester's session room; with no session
      // there is nobody to deliver it to, so the card would block its runtime
      // until expiry. Refuse up front instead of dropping the push later.
      if (!runtimeSessionId) {
        throw new HttpError("This bot has no runtime session to deliver the answer to", {
          status: 409,
          code: "DECISION_REQUESTER_NOT_ACTIVE",
        })
      }

      const decision = await DecisionRequestRepository.insert(client, {
        id: decisionRequestId(),
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        requesterBotId: params.botId,
        requesterRuntimeSessionId: runtimeSessionId,
        requesterInvocationId: invocation?.id ?? null,
        kind: params.kind,
        title: params.title,
        bodyMarkdown: params.bodyMarkdown ?? null,
        options: params.options,
        allowNote: params.allowNote,
        externalRef: params.externalRef ?? null,
        expiresAt: params.expiresAt ?? null,
      })

      const payload: DecisionRequestedEventPayload = {
        decisionId: decision.id,
        decision: serializeDecisionRequest(decision),
        triggerMessageId: invocation?.sourceMessageId,
      }
      const event = await StreamEventRepository.insert(client, {
        id: eventId(),
        streamId: decision.streamId,
        eventType: "decision:requested",
        payload,
        actorId: params.botId,
        actorType: AuthorTypes.BOT,
      })
      await OutboxRepository.insert(client, "stream:decision_requested", {
        workspaceId: decision.workspaceId,
        streamId: decision.streamId,
        event,
      })
      return decision
    })
  }

  /** Bot-plane read: workspace-scoped only; the public API narrows to the requester bot. */
  async getById(params: { workspaceId: string; id: string }): Promise<DecisionRequestRecord | null> {
    return DecisionRequestRepository.findById(this.pool, params.workspaceId, params.id)
  }

  /**
   * Answer a decision as a stream member. 404 hides a decision the user cannot
   * reach (INV-62); a lost CAS is a 409 carrying the row that won, so the caller
   * can show the answer instead of a failure.
   */
  async resolve(params: ResolveDecisionParams): Promise<DecisionRequestRecord> {
    return withTransaction(this.pool, async (client) => {
      const decision = await DecisionRequestRepository.findById(client, params.workspaceId, params.id)
      if (!decision) {
        throw new HttpError("Decision not found", { status: 404, code: "DECISION_NOT_FOUND" })
      }
      const access = await checkStreamAccess(client, decision.streamId, params.workspaceId, params.userId)
      if (!access) {
        throw new HttpError("Decision not found", { status: 404, code: "DECISION_NOT_FOUND" })
      }
      if (!decision.options.some((option) => option.id === params.optionId)) {
        throw new HttpError("Unknown option for this decision", { status: 400, code: "DECISION_OPTION_UNKNOWN" })
      }
      if (params.note !== undefined && !decision.allowNote) {
        throw new HttpError("This decision does not accept a note", { status: 400, code: "DECISION_NOTE_NOT_ALLOWED" })
      }

      const resolution: DecisionResolution = {
        optionId: params.optionId,
        note: params.note,
        decidedBy: params.userId,
        decidedAt: new Date().toISOString(),
      }
      const resolved = await DecisionRequestRepository.resolve(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        expectedVersion: params.version,
        resolution,
      })
      if (!resolved) {
        const current = await DecisionRequestRepository.findById(client, params.workspaceId, params.id)
        throw new HttpError("Decision is no longer open", {
          status: 409,
          code: "DECISION_NOT_OPEN",
          details: current ? serializeDecisionRequest(current) : undefined,
        })
      }

      await this.appendResolvedEvent(client, resolved)
      await this.notifyRequester(client, resolved, "bot_decision:resolved")
      return resolved
    })
  }

  /**
   * Withdraw a decision the requester no longer needs answered. Returns `null`
   * when it already moved — cancelling twice is not an error.
   */
  async cancel(params: { workspaceId: string; id: string; version?: number }): Promise<DecisionRequestRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const cancelled = await DecisionRequestRepository.cancel(client, params)
      if (!cancelled) return null
      await this.appendResolvedEvent(client, cancelled)
      await this.notifyRequester(client, cancelled, "bot_decision:cancelled")
      return cancelled
    })
  }

  /**
   * Move every lapsed open decision to `expired` and patch its card. The
   * requester learns of it as a `decision:cancelled` push carrying
   * `status: "expired"` — same shape as a withdrawal, so a waiting runtime has
   * one unblock path, not two.
   */
  async expireDue(now: Date = new Date()): Promise<DecisionRequestRecord[]> {
    return withTransaction(this.pool, async (client) => {
      const expired = await DecisionRequestRepository.expireDue(client, now)
      for (const decision of expired) {
        await this.appendResolvedEvent(client, decision)
        await this.notifyRequester(client, decision, "bot_decision:cancelled")
      }
      return expired
    })
  }

  private async appendResolvedEvent(client: Querier, decision: DecisionRequestRecord): Promise<void> {
    const payload: DecisionResolvedEventPayload = {
      decisionId: decision.id,
      status: decision.status,
      resolution: decision.resolution ?? undefined,
      version: decision.version,
    }
    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: decision.streamId,
      eventType: "decision:resolved",
      payload,
      actorId: decision.resolution?.decidedBy ?? decision.requesterBotId ?? undefined,
      actorType: decision.status === DecisionRequestStatuses.RESOLVED ? AuthorTypes.USER : AuthorTypes.BOT,
    })
    await OutboxRepository.insert(client, "stream:decision_resolved", {
      workspaceId: decision.workspaceId,
      streamId: decision.streamId,
      event,
    })
  }

  /**
   * Queue the bot-plane push in the same transaction as the write. Only a
   * decision whose requester named a session has a room to deliver to; a
   * human-opened one has nobody blocked on it.
   */
  private async notifyRequester(
    client: Querier,
    decision: DecisionRequestRecord,
    eventType: "bot_decision:resolved" | "bot_decision:cancelled"
  ): Promise<void> {
    if (!decision.requesterBotId || !decision.requesterRuntimeSessionId) return
    await OutboxRepository.insert(client, eventType, {
      workspaceId: decision.workspaceId,
      botId: decision.requesterBotId,
      streamId: decision.streamId,
      runtimeSessionId: decision.requesterRuntimeSessionId,
      decisionId: decision.id,
      status: decision.status,
      optionId: decision.resolution?.optionId ?? null,
      note: decision.resolution?.note ?? null,
      version: decision.version,
    })
  }
}
