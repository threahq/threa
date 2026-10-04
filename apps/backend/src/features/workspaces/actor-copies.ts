import type { Querier } from "../../db"
import type { BridgeActor } from "@threahq/types"
import { OutboxRepository } from "../../lib/outbox"
import { ActorCopyRepository } from "./actor-copy-repository"

/**
 * Keeps a copy here of each host persona or bot a shared channel's changes
 * name, under the host's id, name and emoji. A copy held under another origin
 * is left alone, so the caller checks origins after this and rolls back.
 */
export async function syncActorCopies(
  client: Querier,
  params: { workspaceId: string; originWorkspaceId: string; actors: BridgeActor[] }
): Promise<void> {
  const { workspaceId, originWorkspaceId, actors } = params
  const changed = await ActorCopyRepository.upsert(client, { workspaceId, originWorkspaceId, actors })
  await OutboxRepository.insertMany(
    client,
    changed.map((actorCopy) => ({
      eventType: "actor_copy:upserted" as const,
      payload: { workspaceId, actorCopy },
    }))
  )
}
