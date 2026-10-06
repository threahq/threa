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
  "memo:created",
  "conversation:created",
  "conversation:updated",
] satisfies OutboxEventType[]

/**
 * Pokes the partner of every active connection whose shared tree a batch of
 * events touched, and the other end of every active connection of a workspace
 * whose users changed. A copy's change never pokes the workspace it is a copy
 * of, so a host relays one partner's change to the others without echoing it
 * back. A lost poke only delays the other end until its sweep, so a failed one
 * is logged and the batch still completes.
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
    const userChanges = events.flatMap(changedUsers)
    const linked = await StreamConnectionRepository.listActiveLinkedConnections(this.db, [
      ...new Set(userChanges.map((change) => change.workspaceId)),
    ])
    const profileAddresses = linked
      .filter((connection) =>
        userChanges.some(
          (change) =>
            change.workspaceId === connection.workspaceId && change.originWorkspaceId !== connection.remoteWorkspaceId
        )
      )
      .map((connection) => ({
        workspaceId: connection.remoteWorkspaceId,
        connectionId: connection.connectionId,
        callerWorkspaceId: connection.workspaceId,
      }))

    const pokes = await Promise.allSettled([
      ...connections.map((connection) => this.bridgeClient.poke(connection)),
      ...profileAddresses.map((address) => this.bridgeClient.pokeProfiles(address)),
    ])
    const targets = [...connections, ...profileAddresses]
    pokes.forEach((poke, i) => {
      if (poke.status === "rejected") log.warn({ err: poke.reason, ...targets[i] }, "Bridge poke failed")
    })
    return events.map((event) => event.id)
  }
}

function changedUsers(event: OutboxEvent): { workspaceId: string; originWorkspaceId: string | null }[] {
  if (!isOutboxEventType(event, "workspace_user:updated")) return []
  return [{ workspaceId: event.payload.workspaceId, originWorkspaceId: event.payload.user.originWorkspaceId }]
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
