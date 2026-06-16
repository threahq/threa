import type { Pool } from "pg"
import { StreamRepository } from "./repository"
import { parseMessagePayload } from "../../lib/outbox"
import { needsAutoNaming } from "./display-name"
import { logger } from "../../lib/logger"
import { AuthorTypes } from "@threa/types"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"

export type NamingHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Dispatches auto-naming jobs for scratchpads and threads that still need a
 * generated display name. Uses time-based cursor locking for exclusive access
 * without holding database connections during processing.
 */
export class NamingHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: NamingHandlerConfig) {
    super(db, { listenerId: "naming", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType !== "message:created") {
      return
    }

    const payload = parseMessagePayload(event.payload)
    if (!payload) {
      logger.debug({ eventId: event.id.toString() }, "NamingHandler: malformed event, skipping")
      return
    }

    const { streamId, workspaceId, event: messageEvent } = payload
    const isAgentMessage = messageEvent.actorType !== AuthorTypes.USER

    // E2E streams: auto-naming reads message content which is ciphertext
    // on E2E streams. The client picks a name locally instead.
    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
      return
    }

    const stream = await StreamRepository.findById(this.db, streamId)
    if (!stream) {
      logger.warn({ streamId }, "NamingHandler: stream not found")
      return
    }

    if (!needsAutoNaming(stream)) {
      return
    }

    await this.jobQueue.send(JobQueues.NAMING_GENERATE, {
      workspaceId: stream.workspaceId,
      streamId,
      requireName: isAgentMessage,
    })

    logger.info({ streamId, requireName: isAgentMessage }, "Naming job dispatched")
  }
}
