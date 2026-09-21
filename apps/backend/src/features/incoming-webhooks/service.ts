import { createHash, randomBytes, timingSafeEqual } from "crypto"
import type { Pool } from "pg"
import { parseMarkdown } from "@threahq/prosemirror"
import { HttpError } from "@threahq/backend-common"
import { AuthorTypes, sentViaWebhook, StreamTypes } from "@threahq/types"
import { withTransaction, type Querier } from "../../db"
import { hookId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { E2eStreamsRepository } from "../e2e-streams"
import { normalizeMessage, toEmoji } from "../emoji"
import type { EventService } from "../messaging"
import { checkStreamAccess } from "../streams"
import { IncomingWebhookRepository, type IncomingWebhookRow } from "./repository"

const SECRET_BYTE_LENGTH = 32
/** The public API's message limit. */
export const MAX_WEBHOOK_MARKDOWN_LENGTH = 50_000
const MAX_ACTIVE_HOOKS_PER_BOT = 25
const HOOK_TARGET_STREAM_TYPES: ReadonlySet<string> = new Set([StreamTypes.CHANNEL, StreamTypes.SCRATCHPAD])

/** Satisfied by `StreamService` (INV-12). */
export interface BotStreamJoiner {
  addBotToStreamOn(
    client: Querier,
    targetStreamId: string,
    botId: string,
    workspaceId: string,
    actorId: string,
    personalOwnerId?: string
  ): Promise<void>
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function secretsMatch(storedHash: string, candidate: string): boolean {
  const stored = Buffer.from(storedHash, "hex")
  const provided = Buffer.from(hashSecret(candidate), "hex")
  return stored.length === provided.length && timingSafeEqual(stored, provided)
}

export class IncomingWebhookService {
  private pool: Pool
  private streamService: BotStreamJoiner
  private eventService: EventService

  constructor(deps: { pool: Pool; streamService: BotStreamJoiner; eventService: EventService }) {
    this.pool = deps.pool
    this.streamService = deps.streamService
    this.eventService = deps.eventService
  }

  async create(params: {
    workspaceId: string
    botId: string
    streamId: string
    name: string
    createdBy: string
    personalOwnerId?: string
  }): Promise<{ row: IncomingWebhookRow; secret: string }> {
    const secret = randomBytes(SECRET_BYTE_LENGTH).toString("base64url")
    const secretHash = hashSecret(secret)

    const row = await withTransaction(this.pool, async (client) => {
      // Holds the bot row FOR UPDATE for the rest of the transaction, which serializes the
      // cap check below against a concurrent create.
      await this.claimTarget(client, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        streamId: params.streamId,
        actorId: params.createdBy,
        personalOwnerId: params.personalOwnerId,
      })

      const active = await IncomingWebhookRepository.countActiveByBot(client, params.workspaceId, params.botId)
      if (active >= MAX_ACTIVE_HOOKS_PER_BOT) {
        throw new HttpError(`Maximum of ${MAX_ACTIVE_HOOKS_PER_BOT} active webhooks per bot`, {
          status: 400,
          code: "WEBHOOK_LIMIT_REACHED",
        })
      }

      return IncomingWebhookRepository.insert(client, {
        id: hookId(),
        workspaceId: params.workspaceId,
        botId: params.botId,
        streamId: params.streamId,
        name: params.name,
        secretHash,
        createdBy: params.createdBy,
      })
    })

    return { row, secret }
  }

  /** Validates a hook's target stream and grants the bot access to it. */
  private async claimTarget(
    client: Querier,
    params: { workspaceId: string; botId: string; streamId: string; actorId: string; personalOwnerId?: string }
  ): Promise<void> {
    const stream = await checkStreamAccess(client, params.streamId, params.workspaceId, params.actorId)
    if (!stream) {
      throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
    }
    if (!HOOK_TARGET_STREAM_TYPES.has(stream.type) || stream.rootStreamId !== null) {
      throw new HttpError("Webhooks can only target a channel or a scratchpad", {
        status: 400,
        code: "STREAM_TYPE_NOT_SUPPORTED",
      })
    }
    if (await E2eStreamsRepository.isE2eStream(client, params.workspaceId, params.streamId)) {
      throw new HttpError("Webhooks cannot target an encrypted stream", {
        status: 400,
        code: "E2E_STREAM_NOT_SUPPORTED",
      })
    }

    await this.streamService.addBotToStreamOn(
      client,
      params.streamId,
      params.botId,
      params.workspaceId,
      params.actorId,
      params.personalOwnerId
    )
  }

  async update(params: {
    workspaceId: string
    botId: string
    id: string
    actorId: string
    personalOwnerId?: string
    name?: string
    streamId?: string
  }): Promise<IncomingWebhookRow> {
    return withTransaction(this.pool, async (client) => {
      const row = await IncomingWebhookRepository.updateOwned(client, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        id: params.id,
        name: params.name ?? null,
        streamId: params.streamId ?? null,
      })
      if (!row) {
        const exists = await IncomingWebhookRepository.existsOwned(client, params.workspaceId, params.botId, params.id)
        if (!exists) throw new HttpError("Webhook not found", { status: 404, code: "NOT_FOUND" })
        throw new HttpError("Webhook already revoked", { status: 400, code: "ALREADY_REVOKED" })
      }

      // After the update, so a rejected target rolls the move back with it.
      if (params.streamId) {
        await this.claimTarget(client, {
          workspaceId: params.workspaceId,
          botId: params.botId,
          streamId: params.streamId,
          actorId: params.actorId,
          personalOwnerId: params.personalOwnerId,
        })
      }

      return row
    })
  }

  async listByBot(workspaceId: string, botId: string): Promise<IncomingWebhookRow[]> {
    return IncomingWebhookRepository.listByBot(this.pool, workspaceId, botId)
  }

  async revoke(workspaceId: string, botId: string, id: string): Promise<void> {
    const result = await IncomingWebhookRepository.revokeOwned(this.pool, workspaceId, botId, id)
    if (result === "not_found") {
      throw new HttpError("Webhook not found", { status: 404, code: "NOT_FOUND" })
    }
    if (result === "already_revoked") {
      throw new HttpError("Webhook already revoked", { status: 400, code: "ALREADY_REVOKED" })
    }
  }

  /** Null for an unknown, revoked or mismatched hook, or an archived bot. */
  async authenticate(workspaceId: string, id: string, secret: string): Promise<{ hook: IncomingWebhookRow } | null> {
    const hook = await IncomingWebhookRepository.findLive(this.pool, workspaceId, id)
    if (!hook) return null
    if (!secretsMatch(hook.secretHash, secret)) return null
    return { hook }
  }

  /** Posts as the hook's bot on the hook's stream, over the same path a bot API key takes. */
  async post(hook: IncomingWebhookRow, markdown: string): Promise<{ messageId: string }> {
    const principal = { kind: "bot", botId: hook.botId } as const
    await this.eventService.assertStreamWritableForPrincipal(principal, hook.workspaceId, hook.streamId)
    if (await E2eStreamsRepository.isE2eStream(this.pool, hook.workspaceId, hook.streamId)) {
      throw new HttpError("Stream is end-to-end encrypted; a webhook cannot post plaintext to it", {
        status: 400,
        code: "E2E_STREAM_REQUIRES_CIPHERTEXT",
      })
    }

    const contentMarkdown = normalizeMessage(markdown)
    // No attachment linking: a hook cannot upload, so an `attachment:` id in its markdown is
    // never its own.
    const contentJson = parseMarkdown(contentMarkdown, undefined, toEmoji)

    const { message } = await this.eventService.createMessageForPrincipalReturningConversation(principal, {
      workspaceId: hook.workspaceId,
      streamId: hook.streamId,
      authorId: hook.botId,
      authorType: AuthorTypes.BOT,
      contentJson,
      contentMarkdown,
      sentVia: sentViaWebhook(hook.id),
    })

    // Only a delivered post counts as use, so a hook that authenticates but can no longer write reads as stale.
    void IncomingWebhookRepository.touchLastUsed(this.pool, hook.workspaceId, hook.id).catch((err) => {
      logger.warn({ err, hookId: hook.id }, "Failed to touch incoming webhook last_used_at")
    })

    return { messageId: message.id }
  }
}
