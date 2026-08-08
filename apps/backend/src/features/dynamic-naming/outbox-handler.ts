import type { Pool } from "pg"
import { StreamTypes, TitleSources } from "@threa/types"
import { parseMessagePayload } from "../../lib/outbox"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { JobQueues, type QueueManager } from "../../lib/queue"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository } from "../streams"
import { DYNAMIC_NAMING_QUIET_MS } from "./config"
import { DynamicNamingStateRepository } from "./state-repository"
import type { DynamicNamingJobScheduler, DynamicNamingTargetKind } from "./types"

export class QueueDynamicNamingScheduler implements DynamicNamingJobScheduler {
  constructor(private readonly queue: QueueManager) {}

  async schedule(
    data: { workspaceId: string; targetKind: DynamicNamingTargetKind; targetId: string },
    processAfter?: Date
  ): Promise<void> {
    await this.queue.send(JobQueues.DYNAMIC_NAMING_EVALUATE, data, { processAfter })
  }
}

export class DynamicNamingOutboxHandler extends DebouncedOutboxHandler {
  constructor(
    pool: Pool,
    private readonly scheduler: DynamicNamingJobScheduler,
    config?: DebouncedOutboxHandlerConfig
  ) {
    super(pool, { listenerId: "dynamic-naming", ...config })
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType !== "message:created") return
    const payload = parseMessagePayload(event.payload)
    if (!payload) return

    const stream = await StreamRepository.findById(this.db, payload.streamId)
    if (!stream || stream.workspaceId !== payload.workspaceId || stream.archivedAt) return
    if (stream.type !== StreamTypes.SCRATCHPAD && stream.type !== StreamTypes.THREAD) return
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) return
    const source = stream.displayNameSource ?? (stream.displayName ? TitleSources.LEGACY : null)
    if (source !== null && source !== TitleSources.GENERATED) return
    const state = await DynamicNamingStateRepository.find(this.db, payload.workspaceId, "stream", payload.streamId)
    if (state?.completedAt && state.structureVersion <= state.lastEvaluatedStructureVersion) return

    await this.scheduler.schedule(
      { workspaceId: payload.workspaceId, targetKind: "stream", targetId: payload.streamId },
      new Date(event.createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS)
    )
  }
}
