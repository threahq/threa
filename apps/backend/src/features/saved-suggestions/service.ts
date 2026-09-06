import type { Pool } from "pg"
import { withClient, withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { SavedSuggestionStatuses, type SavedSuggestionView, type SavedMessageView } from "@threahq/types"
import { logger } from "../../lib/logger"
import { SuggestionExtractor, type ExtractorParticipant } from "./extractor"
import { SavedSuggestionsRepository, type SavedSuggestion, type InsertSuggestionParams } from "./repository"
import { toSuggestionView } from "./view"
import { SUGGESTION_CONFIDENCE_FLOOR, SUGGESTION_DISMISSED_EXAMPLE_LIMIT } from "./config"

/** Saved-item creation surface the collector needs on accept — the public slice of SavedMessagesService. */
export interface SavedItemCreator {
  createStandalone(params: {
    workspaceId: string
    userId: string
    title: string
    note: string | null
    remindAt: Date | null
  }): Promise<SavedMessageView>
}

export interface CollectForConversationParams {
  workspaceId: string
  streamId: string
  conversationId: string
  participantIds: string[]
  formattedMessages: string
  authorTimezone?: string
}

export interface SavedSuggestionsServiceConfig {
  pool: Pool
  extractor: SuggestionExtractor
  savedItemCreator: SavedItemCreator
}

/**
 * The quiet collector. Tier-1 capture rides the GAM classifier flag (no work
 * here unless a conversation is flagged); tier-2 extraction runs only for
 * flagged conversations and lands suggestions in a per-assignee pile that is
 * pull-only — no timeline event, no activity row, no badge. Accepting a
 * suggestion is the only path into the saved list.
 */
export class SavedSuggestionsService {
  private pool: Pool
  private extractor: SuggestionExtractor
  private savedItemCreator: SavedItemCreator

  constructor(config: SavedSuggestionsServiceConfig) {
    this.pool = config.pool
    this.extractor = config.extractor
    this.savedItemCreator = config.savedItemCreator
  }

  /**
   * Extract action items from one flagged conversation and persist the
   * confidently-attributed ones. Three phases (INV-41): read participants and
   * prior/dismissed titles, run the extractor with no connection held, then
   * insert + broadcast. Returns the number of new suggestions inserted.
   *
   * Precision over recall: an item is kept only when its confidence clears the
   * floor AND its assignee resolves to a listed participant. Unattributable or
   * low-confidence items are dropped — a small accurate pile is the product.
   */
  async collectForConversation(params: CollectForConversationParams): Promise<number> {
    const { workspaceId, streamId, conversationId, participantIds } = params

    // Phase 1: reads (fast, no AI).
    const { participants, existingTitles, dismissedTitles } = await withClient(this.pool, async (client) => {
      const users = await UserRepository.findByIds(client, workspaceId, participantIds)
      const participants: ExtractorParticipant[] = users.map((u) => ({ userId: u.id, name: u.name }))
      const existingTitles = await SavedSuggestionsRepository.findTitlesByConversation(
        client,
        workspaceId,
        conversationId
      )
      const dismissedTitles = await SavedSuggestionsRepository.findDismissedTitlesByStream(
        client,
        workspaceId,
        streamId,
        SUGGESTION_DISMISSED_EXAMPLE_LIMIT
      )
      return { participants, existingTitles, dismissedTitles }
    })

    if (participants.length === 0) return 0

    // Phase 2: extraction (no connection held).
    const items = await this.extractor.extract(params.formattedMessages, {
      workspaceId,
      conversationId,
      participants,
      existingSuggestionTitles: existingTitles,
      dismissedTitles,
      authorTimezone: params.authorTimezone,
    })

    const validUserIds = new Set(participants.map((p) => p.userId))
    const toInsert: InsertSuggestionParams[] = []
    for (const item of items) {
      if (item.confidence < SUGGESTION_CONFIDENCE_FLOOR) continue
      // Attribution gate: only surface items owned by a known participant, and
      // only in that user's pile (INV-54 — the model resolves ownership).
      if (!item.assigneeUserId || !validUserIds.has(item.assigneeUserId)) continue
      const dueAt = item.dueAtIso ? parseDueDate(item.dueAtIso) : null
      toInsert.push({
        workspaceId,
        userId: item.assigneeUserId,
        streamId,
        conversationId,
        title: item.title,
        context: item.context,
        sourceMessageIds: item.sourceMessageIds,
        dueAt,
        confidence: item.confidence,
      })
    }

    if (toInsert.length === 0) return 0

    // Phase 3: insert (dedup) + broadcast to each assignee.
    const inserted = await withTransaction(this.pool, async (client) => {
      const rows = await SavedSuggestionsRepository.insertMany(client, toInsert)
      for (const row of rows) {
        await OutboxRepository.insert(client, "saved_suggestion:upserted", {
          workspaceId,
          targetUserId: row.userId,
          suggestion: toSuggestionView(row),
        })
      }
      return rows
    })

    if (inserted.length > 0) {
      logger.info({ workspaceId, streamId, conversationId, suggested: inserted.length }, "Saved suggestions collected")
    }
    return inserted.length
  }

  async list(params: {
    workspaceId: string
    userId: string
    status: SavedSuggestionView["status"]
    limit?: number
    cursor?: string
  }): Promise<{ suggestions: SavedSuggestionView[]; nextCursor: string | null }> {
    const limit = params.limit ?? 50
    const rows = await SavedSuggestionsRepository.listByUser(this.pool, params.workspaceId, params.userId, {
      status: params.status,
      limit: limit + 1,
      cursor: params.cursor,
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null
    return { suggestions: page.map(toSuggestionView), nextCursor }
  }

  /**
   * Accept a suggestion: create a standalone saved item (title + extracted
   * context as its note) and mark the suggestion accepted, pinning the new
   * saved id. Idempotent via the `suggested`→`accepted` guard — a double
   * accept finds no suggested row and 404s rather than creating a second item.
   */
  async accept(params: {
    workspaceId: string
    userId: string
    suggestionId: string
  }): Promise<{ suggestion: SavedSuggestionView; saved: SavedMessageView }> {
    const existing = await SavedSuggestionsRepository.findById(
      this.pool,
      params.workspaceId,
      params.userId,
      params.suggestionId
    )
    if (!existing) {
      throw new HttpError("Suggestion not found", { status: 404, code: "SUGGESTION_NOT_FOUND" })
    }
    if (existing.status !== SavedSuggestionStatuses.SUGGESTED) {
      throw new HttpError("Suggestion already resolved", { status: 409, code: "SUGGESTION_NOT_PENDING" })
    }

    // Create the saved item first (its own tx + outbox), then flip the
    // suggestion. The saved item is the durable artifact; if the status flip
    // lost a race the worst case is an orphaned-but-valid saved item, never a
    // suggestion pointing at a item that doesn't exist.
    const saved = await this.savedItemCreator.createStandalone({
      workspaceId: params.workspaceId,
      userId: params.userId,
      title: existing.title,
      note: existing.context,
      remindAt: existing.dueAt,
    })

    const updated = await withTransaction(this.pool, async (client) => {
      const row = await SavedSuggestionsRepository.updateStatus(
        client,
        params.workspaceId,
        params.userId,
        params.suggestionId,
        {
          status: SavedSuggestionStatuses.ACCEPTED,
          expectedStatus: SavedSuggestionStatuses.SUGGESTED,
          savedMessageId: saved.id,
        }
      )
      if (!row) return null
      await OutboxRepository.insert(client, "saved_suggestion:upserted", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        suggestion: toSuggestionView(row),
      })
      return row
    })

    if (!updated) {
      // Lost the race against a concurrent accept/dismiss. The saved item is
      // already created and valid; surface a conflict so the client refetches.
      throw new HttpError("Suggestion already resolved", { status: 409, code: "SUGGESTION_NOT_PENDING" })
    }

    return { suggestion: toSuggestionView(updated), saved }
  }

  /** Dismiss a suggestion. Kept as a negative example for future extraction. */
  async dismiss(params: { workspaceId: string; userId: string; suggestionId: string }): Promise<SavedSuggestionView> {
    const updated = await withTransaction(this.pool, async (client) => {
      const row = await SavedSuggestionsRepository.updateStatus(
        client,
        params.workspaceId,
        params.userId,
        params.suggestionId,
        { status: SavedSuggestionStatuses.DISMISSED, expectedStatus: SavedSuggestionStatuses.SUGGESTED }
      )
      if (!row) return null
      await OutboxRepository.insert(client, "saved_suggestion:upserted", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        suggestion: toSuggestionView(row),
      })
      return row
    })
    if (!updated) {
      throw new HttpError("Suggestion not found", { status: 404, code: "SUGGESTION_NOT_FOUND" })
    }
    return toSuggestionView(updated)
  }
}

/** Parse an extractor-supplied ISO date/datetime; null on anything unparseable. */
function parseDueDate(iso: string): Date | null {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export type { SavedSuggestion }
