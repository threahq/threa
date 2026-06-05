import type { Pool, PoolClient } from "pg"
import { AuthorTypes, ScheduledMessageStatuses, type ScheduledMessageView, type JSONContent } from "@threa/types"
import { withTransaction } from "../../db"
import { HttpError, isUniqueViolation } from "../../lib/errors"
// Side-effect import: matches the load-order workaround used by other features
// that pull in messaging via the public-api schema chain (saved-messages does
// the same — see service.ts there for the TDZ explanation).
import "../workspaces"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository, StreamMemberRepository, type Stream } from "../streams"
import { Visibilities } from "@threa/types"
import { MessageRepository } from "../messaging"
import { EventService } from "../messaging"
import { scheduledMessageId, scheduledMessageQueueId } from "../../lib/id"
import { JobQueues, QueueRepository, enqueueQueuedJob, type ScheduledMessageSendJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import { ScheduledMessagesRepository, type ScheduledMessage } from "./repository"
import { toScheduledMessageView } from "./view"

interface ScheduledMessagesServiceDeps {
  pool: Pool
  eventService: EventService
}

export interface ScheduleParams {
  workspaceId: string
  userId: string
  streamId: string
  parentMessageId: string | null
  contentJson: JSONContent
  contentMarkdown: string
  attachmentIds: string[]
  metadata: Record<string, string> | null
  scheduledFor: Date
  clientMessageId: string | null
}

export interface UpdateScheduledParams {
  workspaceId: string
  userId: string
  id: string
  expectedVersion: number
  contentJson?: JSONContent
  contentMarkdown?: string
  attachmentIds?: string[]
  metadata?: Record<string, string> | null
  scheduledFor?: Date
}

export interface ListScheduledParams {
  workspaceId: string
  userId: string
  status: "pending" | "sent" | "failed" | "cancelled"
  streamId?: string
  limit?: number
  cursor?: string
}

const WORKER_FENCE_TTL_SECONDS = 10
const EDIT_LOCK_TTL_SECONDS = 10 * 60
const MIN_FUTURE_OFFSET_SECONDS = 5

/**
 * Service for the scheduled-message lifecycle: schedule / update / lockForEdit
 * / send-now / cancel / fire (worker entry).
 *
 * Concurrency model — worker pause + first-save-wins:
 *  - Opening the edit dialog calls `lockForEdit` once: bumps a fence
 *    (`edit_active_until`) for `EDIT_LOCK_TTL_SECONDS`. While the fence is
 *    in the future, the worker defers firing — so we never send mid-edit
 *    content. The fence is anonymous (no per-device owner), so multiple
 *    devices/tabs can edit concurrently.
 *  - Saves carry the `updatedAt` the editor last saw. The repository CAS
 *    rejects with 409 STALE_VERSION when the row has moved on (another
 *    save landed, or the worker won past an expired fence). First save wins.
 *  - No heartbeat. The TTL is generous (~10 minutes); if the user is still
 *    editing past that, their save will 409 cleanly and they refresh.
 */
export class ScheduledMessagesService {
  private readonly pool: Pool
  private readonly eventService: EventService

  constructor(deps: ScheduledMessagesServiceDeps) {
    this.pool = deps.pool
    this.eventService = deps.eventService
  }

  /**
   * Create a scheduled message and enqueue its fire job. Idempotent on
   * `clientMessageId` — a duplicate POST returns the existing row instead of
   * creating a second one (mirrors message create semantics).
   *
   * `scheduledFor` is clamped forward to `MIN_FUTURE_OFFSET_SECONDS` from now;
   * a "schedule for the past" request fires almost immediately, which is how
   * offline-replayed mutations recover gracefully without forcing the user to
   * pick a new time.
   */
  async schedule(params: ScheduleParams): Promise<ScheduledMessageView> {
    const clamped = clampToFuture(params.scheduledFor)

    return withTransaction(this.pool, async (client) => {
      if (params.clientMessageId) {
        const existing = await ScheduledMessagesRepository.findByClientMessageId(
          client,
          params.workspaceId,
          params.userId,
          params.clientMessageId
        )
        if (existing) return toScheduledMessageView(existing)
      }

      await this.ensureStreamWriteAccess(client, params.workspaceId, params.userId, params.streamId)

      if (params.parentMessageId) {
        const parent = await MessageRepository.findById(client, params.parentMessageId)
        if (!parent || parent.deletedAt !== null) {
          throw new HttpError("Parent message not found", {
            status: 404,
            code: "SCHEDULED_MESSAGE_PARENT_UNAVAILABLE",
          })
        }
        // Workspace-scope check (INV-8): MessageRepository.findById is keyed
        // by the message PK alone, so we must verify the parent belongs to
        // the caller's workspace via its stream. Without this, a caller could
        // attach a foreign workspace's message id and the row would be
        // accepted (and silently leak workspace boundaries at fire time).
        const parentStream = await StreamRepository.findById(client, parent.streamId)
        if (!parentStream || parentStream.workspaceId !== params.workspaceId) {
          throw new HttpError("Parent message not found", {
            status: 404,
            code: "SCHEDULED_MESSAGE_PARENT_UNAVAILABLE",
          })
        }
      }

      const id = scheduledMessageId()
      let row: ScheduledMessage
      try {
        row = await ScheduledMessagesRepository.insert(client, {
          id,
          workspaceId: params.workspaceId,
          userId: params.userId,
          streamId: params.streamId,
          parentMessageId: params.parentMessageId,
          contentJson: params.contentJson,
          contentMarkdown: params.contentMarkdown,
          attachmentIds: params.attachmentIds,
          metadata: params.metadata,
          scheduledFor: clamped,
          clientMessageId: params.clientMessageId,
        })
      } catch (err) {
        // Concurrent duplicate insert with the same client_message_id — refetch
        // the winner and return it. Same shape the message-create path uses.
        if (params.clientMessageId && isUniqueViolation(err, "idx_scheduled_messages_client_id")) {
          const existing = await ScheduledMessagesRepository.findByClientMessageId(
            client,
            params.workspaceId,
            params.userId,
            params.clientMessageId
          )
          if (existing) return toScheduledMessageView(existing)
        }
        throw err
      }

      const queueId = await this.enqueueSendJob(client, row)
      const updated = (await ScheduledMessagesRepository.findById(client, params.workspaceId, params.userId, id)) ?? {
        ...row,
        queueMessageId: queueId,
      }

      const view = toScheduledMessageView(updated)
      await this.publishUpsert(client, view, params.userId)

      return view
    })
  }

  async list(params: ListScheduledParams): Promise<{ scheduled: ScheduledMessageView[]; nextCursor: string | null }> {
    const limit = params.limit ?? 50
    const rows = await ScheduledMessagesRepository.listByUser(this.pool, params.workspaceId, params.userId, {
      status: params.status,
      streamId: params.streamId,
      limit: limit + 1,
      cursor: params.cursor,
    })

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null

    return { scheduled: pageRows.map(toScheduledMessageView), nextCursor }
  }

  async getById(params: { workspaceId: string; userId: string; id: string }): Promise<ScheduledMessageView | null> {
    const row = await ScheduledMessagesRepository.findById(this.pool, params.workspaceId, params.userId, params.id)
    return row ? toScheduledMessageView(row) : null
  }

  /**
   * Pause the worker from sending while a user has the edit dialog open.
   * Bumps `edit_active_until` to `NOW() + EDIT_LOCK_TTL_SECONDS`. Anonymous
   * — multiple devices/tabs can call this concurrently and only push the
   * fence forward (`GREATEST` semantics in the repo). Idempotent: re-calling
   * just refreshes the fence. No heartbeat; the TTL is generous.
   *
   * Returns `editActiveUntil` so the client can know when its protection
   * runs out (informational; the dialog doesn't actually need to act on it).
   * 404 SCHEDULED_MESSAGE_NOT_FOUND when missing; 409 with status-aware code
   * when the row has already moved past `pending`.
   */
  async lockForEdit(params: {
    workspaceId: string
    userId: string
    id: string
  }): Promise<{ scheduled: ScheduledMessageView; editActiveUntil: Date }> {
    return withTransaction(this.pool, async (client) => {
      await this.assertPendingOrThrow(client, params)
      const bumped = await ScheduledMessagesRepository.bumpEditFence(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        ttlSeconds: EDIT_LOCK_TTL_SECONDS,
      })
      if (!bumped || !bumped.editActiveUntil) {
        // Race: assertPending saw pending but the fence bump landed on a
        // post-pending row (worker just won). Surface the same condition.
        throw new HttpError("Scheduled message no longer pending", {
          status: 409,
          code: "SCHEDULED_MESSAGE_NOT_PENDING",
        })
      }
      return {
        scheduled: toScheduledMessageView(bumped),
        editActiveUntil: bumped.editActiveUntil,
      }
    })
  }

  /**
   * Clear the worker fence so a row stranded mid-edit can fire as soon as
   * its scheduled time arrives. The dialog calls this on close (cancel,
   * navigate-away, save-and-close) so closing doesn't leave the worker
   * fenced for the full 10-minute lock TTL. Idempotent and tolerant of
   * post-pending rows — never raises (best-effort fire-and-forget).
   */
  async releaseEditLock(params: { workspaceId: string; userId: string; id: string }): Promise<void> {
    await ScheduledMessagesRepository.releaseEditFence(this.pool, params.workspaceId, params.id)
  }

  /**
   * Update a pending scheduled message with optimistic concurrency. The
   * client sends `expectedVersion` — the row's `version` integer it last
   * saw. The CAS rejects with 409 STALE_VERSION when the row has moved on
   * (someone else saved since); first save wins.
   *
   * If `scheduledFor` shifts, we cancel the prior queue row and enqueue a
   * fresh one inside the same transaction.
   *
   * If the new `scheduledFor` is in the past, this method calls
   * `EventService.createMessage` atomically and transitions to `sent` — the
   * "Save = Send" semantics from the past-time edit UX. Two competing
   * past-time saves are kept consistent by the `markSent` `status='sending'`
   * guard plus the `clientMessageId: scheduled:<id>` idempotency key.
   */
  async update(params: UpdateScheduledParams): Promise<ScheduledMessageView> {
    return withTransaction(this.pool, async (client) => {
      const existing = await this.assertPendingOrThrow(client, params)

      const updated = await ScheduledMessagesRepository.update(client, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        id: params.id,
        expectedVersion: params.expectedVersion,
        contentJson: params.contentJson,
        contentMarkdown: params.contentMarkdown,
        attachmentIds: params.attachmentIds,
        metadata: params.metadata,
        scheduledFor: params.scheduledFor,
      })
      if (!updated) {
        // expectedVersion didn't match — another save landed first.
        throw new HttpError("Scheduled message was edited elsewhere", {
          status: 409,
          code: "SCHEDULED_MESSAGE_STALE_VERSION",
        })
      }

      const scheduledForChanged =
        params.scheduledFor !== undefined && params.scheduledFor.getTime() !== existing.scheduledFor.getTime()

      const finalRow =
        (await ScheduledMessagesRepository.findById(client, params.workspaceId, params.userId, params.id)) ?? updated

      // Past-time save = atomic send (per the past-time editing UX). The
      // worker's CAS will see status='sending' and skip; the editor's CAS
      // already won the optimistic update so we own this transition. Bypass
      // the fence — the *user's own* `lockForEdit` set it; if we honored it
      // here, the row would deadlock (worker fenced out, user 409s).
      if (finalRow.scheduledFor.getTime() <= Date.now()) {
        const flipped = await ScheduledMessagesRepository.tryStartSend(client, {
          workspaceId: params.workspaceId,
          id: params.id,
          ttlSeconds: WORKER_FENCE_TTL_SECONDS,
          bypassFence: true,
        })
        if (!flipped) {
          // Worker won between the update and the start-send CAS. Surface
          // the condition so the client refreshes; the worker's path will
          // complete the send if it's currently in flight.
          throw new HttpError("Scheduled message no longer pending", {
            status: 409,
            code: "SCHEDULED_MESSAGE_NOT_PENDING",
          })
        }
        if (existing.queueMessageId) {
          await QueueRepository.cancelById(client, existing.queueMessageId)
        }
        return await this.finalizeSendInTx(client, flipped)
      }

      // Reschedule: cancel old queue row and enqueue a fresh one in the same
      // tx. Worker's status guard catches any tick that lost the cancel race.
      if (scheduledForChanged) {
        if (existing.queueMessageId) {
          await QueueRepository.cancelById(client, existing.queueMessageId)
        }
        await this.enqueueSendJob(client, finalRow)
      }

      const view = toScheduledMessageView(finalRow)
      await this.publishUpsert(client, view, params.userId)

      return view
    })
  }

  async sendNow(params: { workspaceId: string; userId: string; id: string }): Promise<ScheduledMessageView> {
    return withTransaction(this.pool, async (client) => {
      const existing = await this.assertPendingOrThrow(client, params)

      // Take the worker-style CAS atomically (status flip → sending). Bypass
      // the fence — the user explicitly asked to send right now; their own
      // (or a sibling tab's) `lockForEdit` shouldn't block them.
      const claimed = await ScheduledMessagesRepository.tryStartSend(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        ttlSeconds: WORKER_FENCE_TTL_SECONDS,
        bypassFence: true,
      })
      if (!claimed) {
        // `tryStartSend` requires `scheduled_for <= NOW()`. For a future-
        // scheduled message, force the send by setting scheduled_for to now
        // and retrying.
        const forcedNow = await ScheduledMessagesRepository.update(client, {
          workspaceId: params.workspaceId,
          userId: params.userId,
          id: params.id,
          expectedVersion: existing.version,
          scheduledFor: new Date(),
        })
        if (!forcedNow) {
          throw new HttpError("Scheduled message was edited elsewhere", {
            status: 409,
            code: "SCHEDULED_MESSAGE_STALE_VERSION",
          })
        }
        const reclaimed = await ScheduledMessagesRepository.tryStartSend(client, {
          workspaceId: params.workspaceId,
          id: params.id,
          ttlSeconds: WORKER_FENCE_TTL_SECONDS,
          bypassFence: true,
        })
        if (!reclaimed) {
          throw new HttpError("Scheduled message no longer pending", {
            status: 409,
            code: "SCHEDULED_MESSAGE_NOT_PENDING",
          })
        }
        if (existing.queueMessageId) {
          await QueueRepository.cancelById(client, existing.queueMessageId)
        }
        return await this.finalizeSendInTx(client, reclaimed)
      }

      if (existing.queueMessageId) {
        await QueueRepository.cancelById(client, existing.queueMessageId)
      }

      return await this.finalizeSendInTx(client, claimed)
    })
  }

  async cancel(params: { workspaceId: string; userId: string; id: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const existing = await this.assertPendingOrThrow(client, params, {
        notPendingMessage: (status) => `Cannot cancel ${status} scheduled message`,
      })

      const cancelled = await ScheduledMessagesRepository.cancel(client, params.workspaceId, params.userId, params.id)
      if (!cancelled) {
        // Race: someone else (worker) won between findById and cancel.
        throw new HttpError("Already sending or sent", {
          status: 409,
          code: "SCHEDULED_MESSAGE_ALREADY_SENDING",
        })
      }

      if (existing.queueMessageId) {
        await QueueRepository.cancelById(client, existing.queueMessageId)
      }

      await OutboxRepository.insert(client, "scheduled_message:cancelled", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        scheduledId: params.id,
      })
    })
  }

  /**
   * Worker entry. Re-reads scoped to (workspaceId, id) per INV-8, then attempts
   * the start-send CAS. Returns `{ fired }` so the worker can log + decide
   * whether to defer-and-retry on contention. The status flip stays in
   * place for `WORKER_FENCE_TTL_SECONDS` which is plenty for the EventService
   * send + outbox writes.
   */
  async fire(params: {
    workspaceId: string
    scheduledMessageId: string
  }): Promise<{ fired: boolean; reschedule: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const row = await ScheduledMessagesRepository.findByIdScoped(
        client,
        params.workspaceId,
        params.scheduledMessageId
      )
      if (!row) {
        logger.debug({ ...params }, "scheduled_message fire skipped — row missing")
        return { fired: false, reschedule: false }
      }
      if (row.status !== ScheduledMessageStatuses.PENDING) {
        logger.debug({ ...params, status: row.status }, "scheduled_message fire skipped — not pending")
        return { fired: false, reschedule: false }
      }
      if (row.scheduledFor.getTime() > Date.now()) {
        // Stale leased queue row that survived a reschedule cancel — the
        // editor pushed scheduled_for forward and a fresh queue row is
        // already enqueued for the new time. Drop this tick silently; the
        // new queue row will fire when due.
        logger.debug(
          { ...params, scheduledFor: row.scheduledFor.toISOString() },
          "scheduled_message fire skipped — rescheduled to future"
        )
        return { fired: false, reschedule: false }
      }
      if (row.editActiveUntil && row.editActiveUntil.getTime() > Date.now()) {
        // The user has the edit dialog open — pause the send so we don't
        // ship mid-edit content. The queue retries on its next tick; once
        // the fence expires (or the dialog closes and the lock TTL drains),
        // the next tick fires the row.
        logger.debug(
          { ...params, editActiveUntil: row.editActiveUntil.toISOString() },
          "scheduled_message fire deferred — edit session active"
        )
        return { fired: false, reschedule: true }
      }

      const claimed = await ScheduledMessagesRepository.tryStartSend(client, {
        workspaceId: params.workspaceId,
        id: params.scheduledMessageId,
        ttlSeconds: WORKER_FENCE_TTL_SECONDS,
      })
      if (!claimed) {
        // The fence was bumped between the pre-read and the CAS, or a
        // competing sender won. Defer for retry; the queue's own
        // exponential backoff handles bounded retry. If the row stays
        // wedged, the queue eventually marks the job failed.
        return { fired: false, reschedule: true }
      }

      try {
        await this.finalizeSendInTx(client, claimed)
        return { fired: true, reschedule: false }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown_error"
        logger.warn({ ...params, error: reason }, "scheduled_message fire failed")
        await ScheduledMessagesRepository.markFailed(client, {
          workspaceId: params.workspaceId,
          id: params.scheduledMessageId,
          reason,
        })
        const view = await this.refetchView(client, row)
        if (view) await this.publishUpsert(client, view, row.userId)
        return { fired: false, reschedule: false }
      }
    })
  }

  /**
   * Shared finalizer used by:
   *   - the worker fire path (after CAS to `sending`),
   *   - send-now (after CAS to `sending`),
   *   - PATCH-when-past-time (after CAS to `sending`).
   *
   * Caller is expected to have already flipped status to `sending`. We assert
   * that here as a safety net (idempotent — if status is already `sent` we
   * no-op).
   */
  private async finalizeSendInTx(client: PoolClient, row: ScheduledMessage): Promise<ScheduledMessageView> {
    if (row.status === ScheduledMessageStatuses.SENT) {
      return toScheduledMessageView(row)
    }
    if (row.status !== ScheduledMessageStatuses.SENDING) {
      throw new Error(`finalizeSendInTx called with status=${row.status}`)
    }

    const message = await this.eventService.createMessage({
      workspaceId: row.workspaceId,
      streamId: row.streamId,
      authorId: row.userId,
      authorType: AuthorTypes.USER,
      contentJson: row.contentJson,
      contentMarkdown: row.contentMarkdown,
      attachmentIds: row.attachmentIds.length > 0 ? row.attachmentIds : undefined,
      metadata: row.metadata ?? undefined,
      // Use the scheduled message id as the idempotency key. If the same
      // scheduled row gets re-fired after an interrupted finalize (process
      // restart between createMessage and markSent), the second attempt
      // returns the existing message instead of duplicating.
      clientMessageId: `scheduled:${row.id}`,
    })

    const sent = await ScheduledMessagesRepository.markSent(client, {
      workspaceId: row.workspaceId,
      id: row.id,
      sentMessageId: message.id,
    })
    const finalRow = sent ?? { ...row, status: ScheduledMessageStatuses.SENT, sentMessageId: message.id }
    const view = toScheduledMessageView(finalRow)

    await OutboxRepository.insert(client, "scheduled_message:sent", {
      workspaceId: row.workspaceId,
      targetUserId: row.userId,
      scheduledId: row.id,
      sentMessageId: message.id,
      streamId: row.streamId,
      scheduled: view,
    })

    return view
  }

  private async refetchView(client: PoolClient, row: ScheduledMessage): Promise<ScheduledMessageView | null> {
    const fresh = await ScheduledMessagesRepository.findByIdScoped(client, row.workspaceId, row.id)
    return fresh ? toScheduledMessageView(fresh) : null
  }

  /**
   * Find a scheduled row scoped to (workspace, user) and assert it's still
   * pending — the precondition for claim / update / sendNow / cancel. Throws
   * 404 when the row is missing, 409 with a status-aware code otherwise.
   * Use `notPendingMessage` to override the user-visible text per call site
   * (e.g. cancel uses "Cannot cancel sending scheduled message").
   */
  private async assertPendingOrThrow(
    client: PoolClient,
    params: { workspaceId: string; userId: string; id: string },
    options?: { notPendingMessage?: (status: string) => string }
  ): Promise<ScheduledMessage> {
    const existing = await ScheduledMessagesRepository.findById(client, params.workspaceId, params.userId, params.id)
    if (!existing) {
      throw new HttpError("Scheduled message not found", {
        status: 404,
        code: "SCHEDULED_MESSAGE_NOT_FOUND",
      })
    }
    if (existing.status !== ScheduledMessageStatuses.PENDING) {
      const buildMessage = options?.notPendingMessage ?? ((status: string) => `Scheduled message already ${status}`)
      throw new HttpError(buildMessage(existing.status), {
        status: 409,
        code:
          existing.status === ScheduledMessageStatuses.SENDING
            ? "SCHEDULED_MESSAGE_ALREADY_SENDING"
            : "SCHEDULED_MESSAGE_NOT_PENDING",
      })
    }
    return existing
  }

  /** Write a `scheduled_message:upserted` outbox row scoped to the row's owner. */
  private publishUpsert(client: PoolClient, view: ScheduledMessageView, userId: string): Promise<unknown> {
    return OutboxRepository.insert(client, "scheduled_message:upserted", {
      workspaceId: view.workspaceId,
      targetUserId: userId,
      scheduled: view,
    })
  }

  /**
   * Insert a `scheduled_message.send` queue row with `process_after =
   * scheduledFor` and pin the queue id back onto the scheduled row. The
   * insert + retry-on-PK-collision loop is shared with saved-messages via
   * `enqueueQueuedJob`; the queue id is then written back here since that
   * step is table-specific.
   */
  private async enqueueSendJob(client: PoolClient, row: ScheduledMessage): Promise<string> {
    const payload: ScheduledMessageSendJobData = {
      workspaceId: row.workspaceId,
      userId: row.userId,
      scheduledMessageId: row.id,
    }
    const queueId = await enqueueQueuedJob(client, {
      queueName: JobQueues.SCHEDULED_MESSAGE_SEND,
      workspaceId: row.workspaceId,
      payload,
      processAfter: row.scheduledFor,
      generateId: scheduledMessageQueueId,
    })
    await ScheduledMessagesRepository.setQueueMessageId(client, row.workspaceId, row.id, queueId)
    return queueId
  }

  /**
   * Stream-write authorization. Mirrors the saved-messages stream-access
   * helper but for write intent: the user must be a member of the stream
   * (or the stream's root for thread sends), and the workspace must match.
   * Public streams allow any workspace user to write — same as live message
   * create.
   */
  private async ensureStreamWriteAccess(
    client: PoolClient,
    workspaceId: string,
    userId: string,
    streamIdParam: string
  ): Promise<Stream> {
    const stream = await StreamRepository.findById(client, streamIdParam)
    if (!stream || stream.workspaceId !== workspaceId) {
      throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })
    }
    if (stream.archivedAt) {
      throw new HttpError("Cannot schedule messages to an archived stream", {
        status: 403,
        code: "STREAM_ARCHIVED",
      })
    }

    // E2EE-3: the server holds no stream key, so it can never seal a future
    // message at fire time. Refuse at schedule time with a loud error rather
    // than accepting plaintext that would either leak into the sealed stream
    // (now backstopped by the INV-E1 sink) or silently fail to send much later.
    // `findById` already populates `e2eEnabled` off the e2e_streams join.
    if (stream.e2eEnabled === true) {
      throw new HttpError("Cannot schedule messages to an end-to-end-encrypted stream", {
        status: 400,
        code: "E2E_STREAM_SCHEDULING_UNSUPPORTED",
      })
    }

    const accessStreamId = stream.rootStreamId ?? stream.id
    let accessStream: Stream | null = stream
    if (stream.rootStreamId) {
      accessStream = await StreamRepository.findById(client, accessStreamId)
      if (!accessStream) {
        throw new HttpError("Parent stream not found", { status: 404, code: "STREAM_NOT_FOUND" })
      }
    }

    if (accessStream.visibility === Visibilities.PUBLIC) return stream

    const isMember = await StreamMemberRepository.isMember(client, accessStreamId, userId)
    if (!isMember) {
      throw new HttpError("Not a member of this stream", { status: 403, code: "FORBIDDEN" })
    }

    return stream
  }
}

function clampToFuture(date: Date): Date {
  const minMs = Date.now() + MIN_FUTURE_OFFSET_SECONDS * 1000
  return date.getTime() < minMs ? new Date(minMs) : date
}
