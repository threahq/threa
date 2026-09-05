import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { DraftsRepository, type Draft } from "./repository"
import { toDraftView } from "./view"

/**
 * Re-point an owner's drafts onto the scratchpads their client draft ids were
 * promoted to, and tell the owner's devices (`draft:upserted`, INV-4/7). Runs
 * inside the caller's transaction: scratchpad promotion calls it right after
 * the stream insert, the drafts bootstrap calls it as repair.
 */
export async function repairPromotedDraftScopes(
  db: Querier,
  params: { workspaceId: string; userId: string }
): Promise<Draft[]> {
  const repointed = await DraftsRepository.repointPromotedDraftScopes(db, params)
  if (repointed.length > 0) {
    await OutboxRepository.insertMany(
      db,
      repointed.map((draft) => ({
        eventType: "draft:upserted" as const,
        payload: { workspaceId: params.workspaceId, targetUserId: draft.userId, draft: toDraftView(draft) },
      }))
    )
  }
  return repointed
}
