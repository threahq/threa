import type { Pool } from "pg"
import { AuthorTypes, type DocUpdatedPayload } from "@threahq/types"
import {
  DebouncedOutboxHandler,
  isOutboxEventType,
  type DebouncedOutboxHandlerConfig,
  type OutboxEvent,
} from "../../lib/outbox"
import { JobQueues, type DocMentionSettleJobData, type QueueManager } from "../../lib/queue"
import { DOC_MENTION_QUIET_MS } from "./config"
import { DocMentionStateRepository } from "./mention-repository"
import { docMentionSettleJobId } from "./mention-service"

interface SettleJob {
  data: DocMentionSettleJobData
  processAfter?: Date
  messageId: string
}

interface AuthoredWrite {
  eventId: bigint
  createdAt: Date
  payload: DocUpdatedPayload
}

function leftABlock(previous: string[] | null, next: string[]): boolean {
  return previous !== null && previous.some((blockId) => !next.includes(blockId))
}

/**
 * Schedules mention settling per (doc, author) from non-system, block-touching `doc:updated`
 * flushes: one job a quiet window after the author's writes, and one at once when a write leaves a
 * block the author's previous write touched, or is an agent/API rewrite.
 */
export class DocMentionOutboxHandler extends DebouncedOutboxHandler {
  constructor(
    pool: Pool,
    private readonly jobQueue: Pick<QueueManager, "send">,
    config?: DebouncedOutboxHandlerConfig
  ) {
    super(pool, { listenerId: "doc-mention", ...config })
  }

  protected async processBatch(events: OutboxEvent[]): Promise<bigint[]> {
    const byAuthor = new Map<string, AuthoredWrite[]>()
    for (const event of events) {
      if (!isOutboxEventType(event, "doc:updated")) continue
      const payload = event.payload
      if (payload.actorType === AuthorTypes.SYSTEM || payload.touchedBlockIds.length === 0) continue
      const key = `${payload.workspaceId}:${payload.streamId}:${payload.actorId}`
      const writes = byAuthor.get(key) ?? []
      writes.push({ eventId: event.id, createdAt: event.createdAt, payload })
      byAuthor.set(key, writes)
    }

    const jobs = new Map<string, SettleJob>()
    for (const writes of byAuthor.values()) {
      const { workspaceId, streamId: docId, actorId } = writes[0]!.payload
      const data = { workspaceId, docId, actorId }
      let previous = await DocMentionStateRepository.findLastBlockIds(this.db, workspaceId, docId, actorId)
      let settleNow = false
      for (const { createdAt, payload } of writes) {
        settleNow ||= payload.reason !== undefined || leftABlock(previous, payload.touchedBlockIds)
        previous = payload.touchedBlockIds
        const messageId = docMentionSettleJobId(docId, actorId, createdAt)
        if (!jobs.has(messageId)) {
          jobs.set(messageId, { data, processAfter: new Date(createdAt.getTime() + DOC_MENTION_QUIET_MS), messageId })
        }
      }
      if (settleNow) {
        const messageId = `doc-mention:${docId}:${actorId}:now:${writes.at(-1)!.eventId}`
        jobs.set(messageId, { data, messageId })
      }
    }

    for (const { data, processAfter, messageId } of jobs.values()) {
      await this.jobQueue.send(JobQueues.DOC_MENTION_SETTLE, data, { processAfter, messageId })
    }
    // Recorded only once the jobs are queued, so a retried batch compares against the same blocks.
    for (const writes of byAuthor.values()) {
      const { workspaceId, streamId: docId, actorId, touchedBlockIds } = writes.at(-1)!.payload
      await DocMentionStateRepository.setLastBlockIds(this.db, workspaceId, docId, actorId, touchedBlockIds)
    }
    return events.map((event) => event.id)
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    await this.processBatch([event])
  }
}
