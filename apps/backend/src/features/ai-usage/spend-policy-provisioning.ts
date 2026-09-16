import type { PoolClient } from "pg"
import { QueueRepository } from "../../lib/queue"
import { SpendPolicyRepository } from "./spend-policy-repository"
import { SpendRepository } from "./spend-repository"
import { AI_SPENDING_PAUSE_PREFIX } from "./spend-job-admission"

export async function provisionUnprotectedSpendingPolicies(db: PoolClient, workspaceIds: string[]): Promise<number> {
  await SpendRepository.lockWorkspaces(db, workspaceIds)
  const inserted = await SpendPolicyRepository.insertUnprotected(db, workspaceIds)
  const unprotected = await SpendPolicyRepository.listUnprotectedWorkspaceIds(db, workspaceIds)
  await QueueRepository.resumePaused(db, { workspaceIds: unprotected, reasonPrefix: AI_SPENDING_PAUSE_PREFIX })
  return inserted
}
