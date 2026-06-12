import type { Pool } from "pg"
import { Visibilities, SavedStatuses, type SavedStatus, type SavedMessageView } from "@threa/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
// Side-effect import: preloads workspaces → public-api → schemas → messaging
// so that the late-exported `messageMetadataSchema` is bound before this
// module's own imports would trigger a partial messaging-barrel load and a
// TDZ in public-api/schemas.ts. Activity's service relies on the same ordering
// via its own workspaces import.
import "../workspaces"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository, StreamMemberRepository } from "../streams"
import { MessageRepository } from "../messaging"
import { reminderQueueId } from "../../lib/id"
import { JobQueues, QueueRepository, enqueueQueuedJob, type SavedReminderFireJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import { SavedMessagesRepository, type SavedMessage } from "./repository"
import { resolveSavedView } from "./view"

interface SavedMessagesServiceDeps {
  pool: Pool
}

export interface SaveParams {
  workspaceId: string
  userId: string
  messageId: string
  remindAt: Date | null
}

export interface CreateStandaloneParams {
  workspaceId: string
  userId: string
  title: string
  note: string | null
  remindAt: Date | null
}

export interface UpdateContentParams {
  workspaceId: string
  userId: string
  savedId: string
  title?: string
  note?: string | null
}

export interface UpdateStatusParams {
  workspaceId: string
  userId: string
  savedId: string
  status: SavedStatus
}

export interface UpdateReminderParams {
  workspaceId: string
  userId: string
  savedId: string
  remindAt: Date | null
}

export interface ListParams {
  workspaceId: string
  userId: string
  status: SavedStatus
  limit?: number
  cursor?: string
}

/** Service for saved-message lifecycle: upserts, status transitions, reminder enqueue/cancel. */
export class SavedMessagesService {
  private readonly pool: Pool

  constructor(deps: SavedMessagesServiceDeps) {
    this.pool = deps.pool
  }

  /**
   * Save a message for the caller. If a row already exists in any status, the
   * upsert resets it to `saved` and overwrites `remind_at`. This matches the
   * product spec: saving a `done`/`archived` entry must bring it back to
   * Saved.
   *
   * Past `remindAt` values are clamped to NOW() server-side so a reminder
   * enqueued in the past fires immediately instead of being rejected.
   */
  async save(params: SaveParams): Promise<SavedMessageView> {
    const clampedRemindAt = clampRemindAt(params.remindAt)

    return withTransaction(this.pool, async (client) => {
      const message = await MessageRepository.findById(client, params.messageId)
      if (!message || message.deletedAt !== null) {
        throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
      }

      const stream = await StreamRepository.findById(client, message.streamId)
      if (!stream || stream.workspaceId !== params.workspaceId) {
        throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
      }

      await ensureStreamAccess(client, {
        accessStreamId: stream.rootStreamId ?? stream.id,
        userId: params.userId,
        directStreamVisibility: stream.visibility,
        isThread: stream.rootStreamId !== null,
      })

      const upsert = await SavedMessagesRepository.upsert(client, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        messageId: params.messageId,
        streamId: message.streamId,
        remindAt: clampedRemindAt,
      })

      // Tombstone the previous queue row (if any) and enqueue a fresh one when
      // a reminder was requested. Both operations run inside the same tx as
      // the row write, so a rolled-back save can't leave a dangling reminder.
      if (upsert.previousReminderQueueMessageId) {
        await QueueRepository.cancelById(client, upsert.previousReminderQueueMessageId)
      }
      const finalRow = clampedRemindAt
        ? await enqueueReminder(client, {
            saved: upsert.saved,
            remindAt: clampedRemindAt,
          })
        : upsert.saved

      const [view] = await resolveSavedView(client, params.userId, [finalRow])

      await OutboxRepository.insert(client, "saved:upserted", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        saved: view!,
      })

      return view!
    })
  }

  /**
   * Create a standalone (message-less) saved item — a manual to-do. No
   * access checks: the item references nothing beyond its own text. Reminder
   * handling matches `save()`: past values clamp to NOW().
   */
  async createStandalone(params: CreateStandaloneParams): Promise<SavedMessageView> {
    const clampedRemindAt = clampRemindAt(params.remindAt)

    return withTransaction(this.pool, async (client) => {
      const inserted = await SavedMessagesRepository.insertStandalone(client, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        title: params.title,
        note: params.note,
        remindAt: clampedRemindAt,
      })

      const finalRow = clampedRemindAt
        ? await enqueueReminder(client, { saved: inserted, remindAt: clampedRemindAt })
        : inserted

      const [view] = await resolveSavedView(client, params.userId, [finalRow])

      await OutboxRepository.insert(client, "saved:upserted", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        saved: view!,
      })

      return view!
    })
  }

  /**
   * Edit title and/or note. Titles are required on standalone items (their
   * only display line), so clearing one is rejected at the schema level —
   * only non-empty title updates reach this method.
   */
  async updateContent(params: UpdateContentParams): Promise<SavedMessageView> {
    return withTransaction(this.pool, async (client) => {
      const updated = await SavedMessagesRepository.updateContent(
        client,
        params.workspaceId,
        params.userId,
        params.savedId,
        { title: params.title, note: params.note }
      )
      if (!updated) {
        throw new HttpError("Saved item not found", { status: 404, code: "SAVED_NOT_FOUND" })
      }

      const [view] = await resolveSavedView(client, params.userId, [updated])

      await OutboxRepository.insert(client, "saved:upserted", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        saved: view!,
      })

      return view!
    })
  }

  async updateStatus(params: UpdateStatusParams): Promise<SavedMessageView> {
    return withTransaction(this.pool, async (client) => {
      const existing = await SavedMessagesRepository.findById(client, params.workspaceId, params.userId, params.savedId)
      if (!existing) {
        throw new HttpError("Saved item not found", { status: 404, code: "SAVED_NOT_FOUND" })
      }

      const updated = await SavedMessagesRepository.updateStatus(
        client,
        params.workspaceId,
        params.userId,
        params.savedId,
        params.status
      )
      if (!updated) {
        throw new HttpError("Saved item not found", { status: 404, code: "SAVED_NOT_FOUND" })
      }

      // Any pending reminder is invalidated by a status change away from
      // 'saved'. The worker also checks status before firing, so even if the
      // cancel lost a race with a claim, the reminder would no-op.
      if (params.status !== SavedStatuses.SAVED && existing.reminderQueueMessageId) {
        await QueueRepository.cancelById(client, existing.reminderQueueMessageId)
      }

      const [view] = await resolveSavedView(client, params.userId, [updated])

      await OutboxRepository.insert(client, "saved:upserted", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        saved: view!,
      })

      return view!
    })
  }

  async updateReminder(params: UpdateReminderParams): Promise<SavedMessageView> {
    const clampedRemindAt = clampRemindAt(params.remindAt)

    return withTransaction(this.pool, async (client) => {
      const existing = await SavedMessagesRepository.findById(client, params.workspaceId, params.userId, params.savedId)
      if (!existing) {
        throw new HttpError("Saved item not found", { status: 404, code: "SAVED_NOT_FOUND" })
      }
      if (existing.status !== SavedStatuses.SAVED) {
        throw new HttpError("Reminder can only be set on active saved items", {
          status: 409,
          code: "SAVED_NOT_ACTIVE",
        })
      }

      // Tombstone any existing queue row and enqueue a new one. Running both
      // inside the tx keeps the saved row and its scheduled reminder in sync.
      if (existing.reminderQueueMessageId) {
        await QueueRepository.cancelById(client, existing.reminderQueueMessageId)
      }
      const updated = await SavedMessagesRepository.updateReminder(
        client,
        params.workspaceId,
        params.userId,
        params.savedId,
        { remindAt: clampedRemindAt, queueMessageId: null }
      )
      if (!updated) {
        throw new HttpError("Saved item not found", { status: 404, code: "SAVED_NOT_FOUND" })
      }

      const finalRow = clampedRemindAt
        ? await enqueueReminder(client, { saved: updated, remindAt: clampedRemindAt })
        : updated

      const [view] = await resolveSavedView(client, params.userId, [finalRow])

      await OutboxRepository.insert(client, "saved:upserted", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        saved: view!,
      })

      return view!
    })
  }

  async delete(params: { workspaceId: string; userId: string; savedId: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const existing = await SavedMessagesRepository.findById(client, params.workspaceId, params.userId, params.savedId)
      if (!existing) {
        throw new HttpError("Saved item not found", { status: 404, code: "SAVED_NOT_FOUND" })
      }

      // A pending reminder on a deleted saved row must not fire. Tombstone it
      // in the same tx as the DELETE.
      if (existing.reminderQueueMessageId) {
        await QueueRepository.cancelById(client, existing.reminderQueueMessageId)
      }

      const deleted = await SavedMessagesRepository.delete(client, params.workspaceId, params.userId, params.savedId)
      if (!deleted) return

      await OutboxRepository.insert(client, "saved:deleted", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        savedId: params.savedId,
        messageId: existing.messageId,
      })
    })
  }

  /**
   * Worker entry point. Guards:
   *   - row exists
   *   - row is still in `saved` status (done/archived tombstoning may have
   *     lost a race with queue claim)
   *   - `reminder_sent_at` is still null (another worker instance may have
   *     already fired)
   *
   * Emits `saved_reminder:fired` in the same tx as the update so the outbox
   * payload reflects committed state.
   */
  async markReminderFired(params: { savedId: string }): Promise<{ fired: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const row = await SavedMessagesRepository.findByIdUnscoped(client, params.savedId)
      if (!row || row.status !== SavedStatuses.SAVED || row.reminderSentAt !== null) {
        return { fired: false }
      }

      const now = new Date()
      const updated = await SavedMessagesRepository.markReminderSent(client, params.savedId, now)
      if (!updated) return { fired: false }

      const [view] = await resolveSavedView(client, row.userId, [updated])

      await OutboxRepository.insert(client, "saved_reminder:fired", {
        workspaceId: row.workspaceId,
        targetUserId: row.userId,
        savedId: row.id,
        messageId: row.messageId,
        streamId: row.streamId,
        saved: view!,
      })

      return { fired: true }
    })
  }

  async list(params: ListParams): Promise<{ saved: SavedMessageView[]; nextCursor: string | null }> {
    const limit = params.limit ?? 50
    const rows = await SavedMessagesRepository.listByUser(this.pool, params.workspaceId, params.userId, {
      status: params.status,
      limit: limit + 1,
      cursor: params.cursor,
    })

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null

    const saved = await resolveSavedView(this.pool, params.userId, pageRows)
    return { saved, nextCursor }
  }

  async findByMessageId(params: {
    workspaceId: string
    userId: string
    messageId: string
  }): Promise<SavedMessage | null> {
    return SavedMessagesRepository.findByMessageId(this.pool, params.workspaceId, params.userId, params.messageId)
  }
}

/**
 * Enqueue a reminder fire job inside the current transaction and pin the
 * queue id back onto the saved row's `reminder_queue_message_id` pointer.
 * The insert + retry-on-PK-collision loop lives in `enqueueQueuedJob`; we
 * only do the table-specific write-back here so a later edit can cancel
 * the exact job we enqueued (the previous "swallow and continue" branch was
 * unsafe because it left the saved row pointing at a queue row that belonged
 * to a different job).
 */
async function enqueueReminder(
  client: import("pg").PoolClient,
  params: { saved: SavedMessage; remindAt: Date }
): Promise<SavedMessage> {
  const payload: SavedReminderFireJobData = {
    workspaceId: params.saved.workspaceId,
    userId: params.saved.userId,
    savedMessageId: params.saved.id,
  }
  const queueMessageId = await enqueueQueuedJob(client, {
    queueName: JobQueues.SAVED_REMINDER_FIRE,
    workspaceId: params.saved.workspaceId,
    payload,
    processAfter: params.remindAt,
    generateId: reminderQueueId,
  })

  const updated = await SavedMessagesRepository.updateReminder(
    client,
    params.saved.workspaceId,
    params.saved.userId,
    params.saved.id,
    { remindAt: params.remindAt, queueMessageId }
  )
  return updated ?? params.saved
}

function clampRemindAt(remindAt: Date | null): Date | null {
  if (!remindAt) return null
  const now = new Date()
  return remindAt.getTime() < now.getTime() ? now : remindAt
}

async function ensureStreamAccess(
  client: import("pg").PoolClient,
  params: {
    accessStreamId: string
    userId: string
    /** Visibility of the message's direct stream. Used only when `isThread` is false. */
    directStreamVisibility: string
    isThread: boolean
  }
): Promise<void> {
  // Threads inherit access from their root stream; the thread stream's own
  // visibility is not authoritative. Non-thread messages use the direct
  // stream's visibility.
  let visibility = params.directStreamVisibility
  if (params.isThread) {
    const root = await StreamRepository.findById(client, params.accessStreamId)
    if (!root) {
      throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
    }
    visibility = root.visibility
  }

  if (visibility === Visibilities.PUBLIC) return

  const isMember = await StreamMemberRepository.isMember(client, params.accessStreamId, params.userId)
  if (!isMember) {
    throw new HttpError("Forbidden", { status: 403, code: "FORBIDDEN" })
  }
}
