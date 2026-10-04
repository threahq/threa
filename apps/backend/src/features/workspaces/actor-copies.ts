import type { Querier } from "../../db"
import type { BridgeActor } from "@threahq/types"
import { OutboxRepository } from "../../lib/outbox"
import { ActorCopyRepository } from "./actor-copy-repository"

/**
 * Keeps a copy here of each host persona or bot a shared channel's changes
 * name, under the host's id, name and emoji. The upsert leaves a copy held
 * under another origin alone and the check after it throws, so the caller's
 * transaction must roll the page back.
 */
export async function syncActorCopies(
  client: Querier,
  params: { workspaceId: string; originWorkspaceId: string; actors: BridgeActor[] }
): Promise<void> {
  const { workspaceId, originWorkspaceId, actors } = params
  const changed = await ActorCopyRepository.upsert(client, { workspaceId, originWorkspaceId, actors })
  const origins = await ActorCopyRepository.findOrigins(
    client,
    workspaceId,
    actors.map((actor) => actor.id)
  )
  for (const [id, origin] of origins) {
    if (origin !== originWorkspaceId) {
      throw new Error(`Actor ${id} from workspace ${originWorkspaceId} is not a copy from there`)
    }
  }
  await OutboxRepository.insertMany(
    client,
    changed.map((actorCopy) => ({
      eventType: "actor_copy:upserted" as const,
      payload: { workspaceId, actorCopy },
    }))
  )
}
