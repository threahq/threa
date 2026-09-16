import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { SpendPolicyRepository } from "./spend-policy-repository"
import { withTransaction } from "../../db"
import { provisionUnprotectedSpendingPolicies } from "./spend-policy-provisioning"

export const AI_SPENDING_POLICY_SEED_BACKFILL_NAME = "ai-spending-policy-seed"

/** The seed covers the whole workspace registry, so its one run is keyed on the `system` queue scope. */
const SEED_SCOPE = "system"

async function plan(ctx: BackfillContext, scope: string): Promise<string[][]> {
  if (scope !== SEED_SCOPE) {
    throw new Error(`${AI_SPENDING_POLICY_SEED_BACKFILL_NAME} runs under the ${SEED_SCOPE} scope, not ${scope}`)
  }
  return chunkIds(await SpendPolicyRepository.listWorkspaceIdsWithoutPolicy(ctx.pool))
}

async function processChunk(ctx: BackfillContext, _scope: string, workspaceIds: string[]) {
  return withTransaction(ctx.pool, async (db) => ({
    processed: await provisionUnprotectedSpendingPolicies(db, workspaceIds),
  }))
}

/** Seeds explicit `unprotected` for workspaces an old replica created without a policy; never edits a row. */
export function registerAISpendingPolicySeedBackfill(): void {
  registerBackfill<string[]>({ name: AI_SPENDING_POLICY_SEED_BACKFILL_NAME, plan, processChunk })
}
