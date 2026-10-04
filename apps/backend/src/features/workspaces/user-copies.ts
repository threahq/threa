import type { Querier } from "../../db"
import { generateUniqueSlug, serializeBigInt } from "@threahq/backend-common"
import type { BridgeUser } from "@threahq/types"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "./user-repository"

/**
 * Keeps a copy here of each host user a shared channel's changes name, under
 * the host's id and current name, so the partner renders who wrote and
 * reacted. A copy's slug is qualified by the host workspace's name when it is
 * first written and never moves after, so mentions of it stay put.
 */
export async function syncUserCopies(
  client: Querier,
  params: { workspaceId: string; originWorkspaceId: string; originWorkspaceName: string; users: BridgeUser[] }
): Promise<void> {
  const { workspaceId, originWorkspaceId } = params
  const origins = await UserRepository.findOrigins(
    client,
    workspaceId,
    params.users.map((user) => user.id)
  )
  const existing: BridgeUser[] = []
  for (const user of params.users) {
    let origin = origins.get(user.id)
    if (origin === undefined) {
      const slug = await generateUniqueSlug(`${user.slug}-${params.originWorkspaceName}`, (candidate) =>
        UserRepository.slugExistsInWorkspace(client, workspaceId, candidate)
      )
      const inserted = await UserRepository.insertCopy(client, {
        id: user.id,
        workspaceId,
        originWorkspaceId,
        name: user.name,
        slug,
      })
      if (inserted) {
        await OutboxRepository.insert(client, "workspace_user:added", { workspaceId, user: serializeBigInt(inserted) })
        continue
      }
      origin = (await UserRepository.findOrigins(client, workspaceId, [user.id])).get(user.id)
    }
    if (origin !== originWorkspaceId) {
      throw new Error(`User ${user.id} from workspace ${originWorkspaceId} is not a copy from there`)
    }
    existing.push(user)
  }
  const renamed = await UserRepository.renameCopies(client, workspaceId, existing)
  await OutboxRepository.insertMany(
    client,
    renamed.map((user) => ({
      eventType: "workspace_user:updated" as const,
      payload: { workspaceId, user: serializeBigInt(user) },
    }))
  )
}
