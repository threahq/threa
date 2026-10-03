import type { Pool } from "pg"
import {
  DebouncedOutboxHandler,
  isOneOfOutboxEventType,
  isOutboxEventType,
  type OutboxEvent,
  type OutboxEventType,
} from "../../lib/outbox"
import { logger } from "../../lib/logger"
import type { BridgeClient } from "./bridge-client"
import { StreamConnectionRepository } from "./repository"

const log = logger.child({ module: "stream-connection-poke" })

const SHARED_CHANGE_EVENTS = [
  "message:created",
  "message:edited",
  "message:deleted",
  "messages:moved",
  "reaction:added",
  "reaction:removed",
  "stream:created",
  "stream:updated",
  "stream:archived",
  "stream:unarchived",
  "stream:display_name_updated",
  "stream:description_set",
] satisfies OutboxEventType[]

/**
 * Pokes the partner of every active connection whose shared tree a batch of
 * events touched. A lost poke only delays the partner until its sweep, so a
 * failed one is logged and the batch still completes.
 */
export class StreamConnectionPokeHandler extends DebouncedOutboxHandler {
  private readonly bridgeClient: BridgeClient

  constructor(db: Pool, bridgeClient: BridgeClient) {
    super(db, { listenerId: "stream-connection-poke" })
    this.bridgeClient = bridgeClient
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    await this.processBatch([event])
  }

  protected async processBatch(events: OutboxEvent[]): Promise<bigint[]> {
    const connections = await StreamConnectionRepository.listActiveHostConnectionsForStreams(
      this.db,
      events.flatMap(changedStreams)
    )
    const pokes = await Promise.allSettled(connections.map((connection) => this.bridgeClient.poke(connection)))
    pokes.forEach((poke, i) => {
      if (poke.status === "rejected") log.warn({ err: poke.reason, ...connections[i] }, "Bridge poke failed")
    })
    return events.map((event) => event.id)
  }
}

function changedStreams(event: OutboxEvent): { workspaceId: string; streamId: string }[] {
  if (isOutboxEventType(event, "messages:moved")) {
    const { workspaceId, sourceStreamId, destinationStreamId } = event.payload
    return [
      { workspaceId, streamId: sourceStreamId },
      { workspaceId, streamId: destinationStreamId },
    ]
  }
  if (!isOneOfOutboxEventType(event, SHARED_CHANGE_EVENTS)) return []
  return [{ workspaceId: event.payload.workspaceId, streamId: event.payload.streamId }]
}
