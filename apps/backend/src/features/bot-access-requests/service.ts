import type { Pool } from "pg"
import type { Querier } from "../../db"
import { withTransaction } from "../../db"
import { botAccessRequestId, eventId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import {
  AuthorTypes,
  type AuthorType,
  type BotAccessRequestedEventPayload,
  type BotAccessStatusChangedEventPayload,
} from "@threahq/types"
import { StreamEventRepository } from "../streams"
import { BotAccessRequestRepository, type BotAccessRequest } from "./repository"

/** The outbox event type that carries each request timeline event to the stream room. */
const BOT_ACCESS_OUTBOX_EVENT_TYPE = {
  "bot_access:requested": "stream:bot_access_requested",
  "bot_access:status_changed": "stream:bot_access_status_changed",
} as const

/**
 * The one collaborator the approve flow needs: apply the bot grant inside the
 * caller's transaction. Satisfied by `StreamService` — injected as a narrow
 * interface so the service stays decoupled and unit-testable (INV-12).
 */
export interface BotGrantWriter {
  addBotToStreamOn(
    client: Querier,
    targetStreamId: string,
    botId: string,
    workspaceId: string,
    actorId: string
  ): Promise<void>
}

interface BotAccessRequestServiceDeps {
  pool: Pool
  streamService: BotGrantWriter
}

export interface RequestAccessParams {
  workspaceId: string
  streamId: string
  botId: string
  botName: string
  delegationId?: string
  delegationTitle?: string
  requestedByLabel?: string
}

/**
 * Lifecycle owner for bot access requests (F3). A bot runtime that receives the
 * workspace-wide `delegation:available` nudge but lacks stream access files a
 * request instead of silently 404ing; a stream member approves (granting the bot
 * standing access + re-nudging the runner) or denies.
 *
 * Every transition appends a timeline event in the same transaction as the row
 * write (INV-4/7): `bot_access:requested` is the visible card; the approve/deny
 * CAS appends a `bot_access:status_changed` patch on it. Approve additionally
 * applies the grant via {@link BotGrantWriter.addBotToStreamOn} in that same
 * transaction, so the grant and the card advance atomically. Concurrency: request
 * is idempotent per the partial unique index, and approve/deny CAS on
 * `status = 'open'` so exactly one resolver wins (INV-20).
 */
export class BotAccessRequestService {
  private readonly pool: Pool
  private readonly streamService: BotGrantWriter

  constructor(deps: BotAccessRequestServiceDeps) {
    this.pool = deps.pool
    this.streamService = deps.streamService
  }

  /**
   * File (or return the existing open) request. Idempotent: a re-request while
   * one is open returns the existing row and appends NO second card — the bot
   * polling the nudge never spawns duplicates. The event/card is appended only
   * for a genuinely new request.
   */
  async request(params: RequestAccessParams): Promise<{ request: BotAccessRequest; created: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const { request, created } = await BotAccessRequestRepository.insertOrGetOpen(client, {
        id: botAccessRequestId(),
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        botId: params.botId,
        botName: params.botName,
        delegationId: params.delegationId ?? null,
        delegationTitle: params.delegationTitle ?? null,
        requestedByLabel: params.requestedByLabel ?? null,
      })
      if (!created) return { request, created }

      const payload: BotAccessRequestedEventPayload = {
        requestId: request.id,
        botId: request.botId,
        botName: request.botName,
        delegationId: request.delegationId ?? undefined,
        delegationTitle: request.delegationTitle ?? undefined,
        requestedByLabel: request.requestedByLabel ?? undefined,
      }
      await this.appendRequestEvent(client, {
        workspaceId: request.workspaceId,
        streamId: request.streamId,
        eventType: "bot_access:requested",
        payload,
        actorId: request.botId,
        actorType: AuthorTypes.BOT,
      })
      return { request, created }
    })
  }

  /** Read a request, workspace-scoped. Single query — pass the pool (INV-30). */
  async getById(params: { workspaceId: string; id: string }): Promise<BotAccessRequest | null> {
    return BotAccessRequestRepository.findById(this.pool, params.workspaceId, params.id)
  }

  /**
   * Approve a request: CAS `open → approved`, apply the bot grant, and append the
   * status patch — one transaction (INV-4/7). `addBotToStreamOn` is idempotent
   * and emits `stream:member_added` itself, so the roster resolves for all
   * members. Returns `null` when the CAS lost the race (already resolved).
   */
  async approve(params: {
    workspaceId: string
    id: string
    streamId?: string
    approvedBy: string
  }): Promise<BotAccessRequest | null> {
    return withTransaction(this.pool, async (client) => {
      const approved = await BotAccessRequestRepository.approve(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        streamId: params.streamId,
        resolvedBy: params.approvedBy,
      })
      if (!approved) return null

      await this.streamService.addBotToStreamOn(
        client,
        approved.streamId,
        approved.botId,
        approved.workspaceId,
        params.approvedBy
      )
      await this.appendStatusEvent(client, approved)
      return approved
    })
  }

  /**
   * Deny a request: CAS `open → denied` and append the status patch. No grant is
   * applied. Returns `null` when the CAS lost the race.
   */
  async deny(params: {
    workspaceId: string
    id: string
    streamId?: string
    deniedBy: string
  }): Promise<BotAccessRequest | null> {
    return withTransaction(this.pool, async (client) => {
      const denied = await BotAccessRequestRepository.deny(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        streamId: params.streamId,
        resolvedBy: params.deniedBy,
      })
      if (!denied) return null
      await this.appendStatusEvent(client, denied)
      return denied
    })
  }

  /**
   * Append the patch that advances the request card to its resolved status,
   * inside the caller's transaction. `delegationId`/`delegationTitle` are
   * duplicated from the request so the broadcast-handler re-nudge branch needs
   * no DB read; the event's actor is the resolving user.
   */
  private async appendStatusEvent(client: Querier, request: BotAccessRequest): Promise<void> {
    const payload: BotAccessStatusChangedEventPayload = {
      requestId: request.id,
      status: request.status === "approved" ? "approved" : "denied",
      resolvedBy: request.resolvedBy ?? undefined,
      delegationId: request.delegationId ?? undefined,
      delegationTitle: request.delegationTitle ?? undefined,
    }
    await this.appendRequestEvent(client, {
      workspaceId: request.workspaceId,
      streamId: request.streamId,
      eventType: "bot_access:status_changed",
      payload,
      actorId: request.resolvedBy ?? undefined,
      actorType: AuthorTypes.USER,
    })
  }

  /**
   * Append a bot-access timeline event (+ its outbox row) inside the caller's
   * transaction. Same envelope as the delegation events: the full stream event
   * rides on the outbox payload so clients append it without a fetch.
   */
  private async appendRequestEvent(
    client: Querier,
    params: {
      workspaceId: string
      streamId: string
      eventType: keyof typeof BOT_ACCESS_OUTBOX_EVENT_TYPE
      payload: BotAccessRequestedEventPayload | BotAccessStatusChangedEventPayload
      actorId?: string
      actorType: AuthorType
    }
  ): Promise<void> {
    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: params.streamId,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
    })
    await OutboxRepository.insert(client, BOT_ACCESS_OUTBOX_EVENT_TYPE[params.eventType], {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      event,
    })
  }
}
