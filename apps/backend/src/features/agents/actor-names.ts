import type { Querier } from "../../db"
import { UserRepository } from "../workspaces"
import { PersonaRepository } from "./persona-repository"

/**
 * Resolve a set of actor ids (users + personas, mixed) to their display
 * names in one batched call.
 *
 * Both `messages.author_id` and `agent_sessions.persona_id` reference the
 * same `id` column space (ULIDs with different prefixes), so any context-
 * building surface that wants "author name → display name" needs to look
 * up both tables and merge. Batches the user lookup (workspace-scoped, INV-8)
 * and persona lookup (workspace-agnostic) in parallel.
 *
 * INV-56: batched lookups, never per-row.
 *
 * Returns a Map keyed by actor id. Missing ids are not in the map; callers
 * decide on the fallback ("Unknown" is the convention).
 */
export async function resolveActorNames(
  db: Querier,
  workspaceId: string,
  actorIds: Iterable<string>
): Promise<Map<string, string>> {
  const ids = [...new Set(actorIds)]
  if (ids.length === 0) return new Map()

  const [users, personas] = await Promise.all([
    UserRepository.findByIds(db, workspaceId, ids),
    PersonaRepository.findByIds(db, ids),
  ])

  const out = new Map<string, string>()
  for (const u of users) out.set(u.id, u.name)
  for (const p of personas) out.set(p.id, p.name)
  return out
}
