import type { Pool } from "pg"
import { OutboxRepository, type ReactionOutboxPayload } from "../../lib/outbox"
import { EmojiUsageRepository } from "./usage-repository"
import { parseMessagePayload } from "../../lib/outbox"
import { AuthorTypes } from "@threa/types"
import { logger } from "../../lib/logger"
import { emojiUsageId } from "../../lib/id"
import { isValidShortcode } from "./emoji"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

export interface EmojiUsageHandlerConfig {
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
 * Extract shortcodes from normalized message content.
 * Content is already normalized (raw emoji converted to :shortcode:).
 * Returns a map of shortcode (without colons) -> count.
 */
function extractEmojiFromContent(content: string): Map<string, number> {
  const counts = new Map<string, number>()
  const regex = /:([a-z0-9_+-]+):/g
  let match

  while ((match = regex.exec(content)) !== null) {
    const shortcode = match[1]
    if (isValidShortcode(shortcode)) {
      counts.set(shortcode, (counts.get(shortcode) ?? 0) + 1)
    }
  }

  return counts
}

/**
 * Strip colons from a shortcode if present.
 */
function stripColons(shortcode: string): string {
  if (shortcode.startsWith(":") && shortcode.endsWith(":")) {
    return shortcode.slice(1, -1)
  }
  return shortcode
}

/**
 * Handler that tracks emoji usage from messages and reactions.
 *
 * Flow:
 * 1. Message/reaction event arrives (via outbox)
 * 2. Extract emoji shortcodes from content or reaction
 * 3. Insert usage records for personalized emoji ordering
 */
export class EmojiUsageHandler implements OutboxHandler {
  readonly listenerId = "emoji-usage"

  private readonly db: Pool
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, config?: EmojiUsageHandlerConfig) {
    this.db = db
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
      (err) => logger.error({ err, listenerId: this.listenerId }, "EmojiUsageHandler debouncer error")
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
          if (event.eventType === "message:created") {
            await this.handleMessageCreated(event)
          } else if (event.eventType === "reaction:added") {
            await this.handleReactionAdded(event)
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

  private async handleMessageCreated(outboxEvent: { id: bigint; payload: unknown }): Promise<void> {
    const payload = parseMessagePayload(outboxEvent.payload)
    if (!payload) {
      logger.debug({ eventId: outboxEvent.id.toString() }, "EmojiUsageHandler: malformed message event, skipping")
      return
    }

    // E2E streams: contentMarkdown is ciphertext, so emoji extraction would
    // produce garbage. Skip without inspecting the message.
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) {
      return
    }

    // Only track user messages (not persona/system messages)
    if (payload.event.actorType !== AuthorTypes.USER) {
      return
    }

    const userId = payload.event.actorId
    if (!userId) {
      logger.warn({ eventId: outboxEvent.id.toString() }, "EmojiUsageHandler: USER message has no actorId, skipping")
      return
    }

    const content = payload.event.payload.contentMarkdown
    const emojiCounts = extractEmojiFromContent(content)

    if (emojiCounts.size === 0) {
      return
    }

    const items = Array.from(emojiCounts.entries()).map(([shortcode, count]) => ({
      id: emojiUsageId(),
      workspaceId: payload.workspaceId,
      userId,
      interactionType: "message" as const,
      shortcode,
      occurrenceCount: count,
      sourceId: payload.event.payload.messageId,
    }))

    // Single batch insert query, INV-30
    await EmojiUsageRepository.insertBatch(this.db, items)

    logger.debug(
      {
        eventId: outboxEvent.id.toString(),
        messageId: payload.event.payload.messageId,
        emojiCount: emojiCounts.size,
      },
      "Emoji usage tracked for message"
    )
  }

  private async handleReactionAdded(outboxEvent: { id: bigint; payload: unknown }): Promise<void> {
    const payload = outboxEvent.payload as ReactionOutboxPayload

    if (!payload.workspaceId || !payload.userId || !payload.emoji || !payload.messageId) {
      logger.debug({ eventId: outboxEvent.id.toString() }, "EmojiUsageHandler: malformed reaction event, skipping")
      return
    }

    // Only track reactions from workspace users. Persona/bot reactions (the
    // agent's react_to_message tool) must not feed a human's emoji
    // personalization. A missing actorType means a legacy/user reaction.
    if (payload.actorType && payload.actorType !== AuthorTypes.USER) {
      return
    }

    // E2E streams: don't record reaction usage. A reaction on a private
    // message is itself sensitive metadata, and Phase 1 keeps these streams
    // opaque to backend personalization.
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) {
      return
    }

    const shortcode = stripColons(payload.emoji)

    if (!isValidShortcode(shortcode)) {
      logger.debug(
        { eventId: outboxEvent.id.toString(), emoji: payload.emoji },
        "EmojiUsageHandler: invalid shortcode in reaction, skipping"
      )
      return
    }

    // Single insert query, INV-30
    await EmojiUsageRepository.insert(this.db, {
      id: emojiUsageId(),
      workspaceId: payload.workspaceId,
      userId: payload.userId,
      interactionType: "message_reaction",
      shortcode,
      occurrenceCount: 1,
      sourceId: payload.messageId,
    })

    logger.debug(
      {
        eventId: outboxEvent.id.toString(),
        messageId: payload.messageId,
        emoji: shortcode,
      },
      "Emoji usage tracked for reaction"
    )
  }
}
