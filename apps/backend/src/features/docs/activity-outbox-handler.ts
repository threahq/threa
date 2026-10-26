import type { Pool } from "pg"
import { AuthorTypes } from "@threahq/types"
import {
  DebouncedOutboxHandler,
  isOutboxEventType,
  type DebouncedOutboxHandlerConfig,
  type OutboxEvent,
} from "../../lib/outbox"
import { JobQueues, type DocActivityRollupJobData, type QueueManager } from "../../lib/queue"
import { docActivityRollupJobId } from "./activity-service"
import { DOC_ACTIVITY_QUIET_MS } from "./config"

interface RollupJob {
  data: DocActivityRollupJobData
  processAfter: Date
  messageId: string
}

function rollupJobFor(event: OutboxEvent): RollupJob | null {
  if (!isOutboxEventType(event, "doc:updated") || event.payload.actorType === AuthorTypes.SYSTEM) return null
  const { workspaceId, streamId: docId } = event.payload
  return {
    data: { workspaceId, docId },
    processAfter: new Date(event.createdAt.getTime() + DOC_ACTIVITY_QUIET_MS),
    messageId: docActivityRollupJobId(docId, event.createdAt),
  }
}

/** Schedules one roll-up per doc per quiet window from its non-system `doc:updated` flushes. */
export class DocActivityOutboxHandler extends DebouncedOutboxHandler {
  constructor(
    pool: Pool,
    private readonly jobQueue: Pick<QueueManager, "send">,
    config?: DebouncedOutboxHandlerConfig
  ) {
    super(pool, { listenerId: "doc-activity", ...config })
  }

  protected async processBatch(events: OutboxEvent[]): Promise<bigint[]> {
    const jobs = new Map<string, RollupJob>()
    for (const event of events) {
      const job = rollupJobFor(event)
      if (job) jobs.set(job.messageId, job)
    }
    for (const job of jobs.values()) await this.send(job)
    return events.map((event) => event.id)
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    const job = rollupJobFor(event)
    if (job) await this.send(job)
  }

  private async send({ data, processAfter, messageId }: RollupJob): Promise<void> {
    await this.jobQueue.send(JobQueues.DOC_ACTIVITY_ROLLUP, data, { processAfter, messageId })
  }
}
