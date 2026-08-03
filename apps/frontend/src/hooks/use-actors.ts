import { useWorkspaceEmoji } from "./use-workspace-emoji"
import { useWorkspaceUsers, useWorkspacePersonas, useWorkspaceBots } from "@/stores/workspace-store"
import { getActorLookup } from "@/stores/actor-lookup"

import type { ActorLookup } from "@/stores/actor-lookup"

export { actorTypeFromId } from "@/stores/actor-lookup"
export type { ActorLookup, ActorStatus } from "@/stores/actor-lookup"

/**
 * Actor names, initials and avatars from cached workspace data — reactive and
 * offline-capable.
 *
 * The maps and the emoji indexes are built once per workspace per change in
 * `stores/actor-lookup`, not once per consumer: this hook is reached three times
 * per rendered message row, and rebuilding three actor Maps plus the ~1,914-entry
 * shortcode index per consumer was the row tree's largest per-render cost. The
 * returned object's identity is stable while its inputs are.
 */
export function useActors(workspaceId: string): ActorLookup {
  const { toEmoji } = useWorkspaceEmoji(workspaceId)

  const users = useWorkspaceUsers(workspaceId)
  const personas = useWorkspacePersonas(workspaceId)
  const bots = useWorkspaceBots(workspaceId)

  return getActorLookup(workspaceId, users, personas, bots, toEmoji)
}
