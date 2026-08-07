import type { Pool } from "pg"
import { withTransaction } from "../../db"
import { dynamicNamingClaimsTotal, dynamicNamingDecisionsTotal } from "../../lib/observability/metrics"
import { DYNAMIC_NAMING_CLAIM_LEASE_SECONDS } from "./config"
import { getNamingEligibility } from "./policy"
import { DynamicNamingStateRepository } from "./state-repository"
import type { DynamicNamingDecision, DynamicNamingTargetAdapter, DynamicNamingTargetKind } from "./types"

interface TargetRef {
  workspaceId: string
  targetKind: DynamicNamingTargetKind
  targetId: string
}

export class DynamicNamingClaimCoordinator {
  constructor(
    private readonly pool: Pool,
    private readonly targetAdapter: DynamicNamingTargetAdapter
  ) {}

  async claim(params: TargetRef & { ownerId: string }) {
    return withTransaction(this.pool, async (client) => {
      const target = await this.targetAdapter.lockAndValidate(client, params)
      if (!target) {
        dynamicNamingClaimsTotal.inc({ target_kind: params.targetKind, action: "protected", checkpoint: "none" })
        return null
      }

      const state = await DynamicNamingStateRepository.ensure(client, params)
      const eligibility = getNamingEligibility(
        {
          lastEvaluatedMessageCount: state.lastEvaluatedMessageCount,
          consecutiveKeeps: state.consecutiveKeeps,
          completed: state.completedAt !== null,
          structureVersion: state.structureVersion,
          lastEvaluatedStructureVersion: state.lastEvaluatedStructureVersion,
        },
        target.messageCount
      )
      if (!eligibility.eligible) return null

      const claim = await DynamicNamingStateRepository.claim(client, {
        ...params,
        ownerId: params.ownerId,
        checkpoint: eligibility.checkpoint,
        messageCount: target.messageCount,
        structureVersion: state.structureVersion,
        titleRevision: target.titleRevision,
        expectedVersion: state.version,
        leaseSeconds: DYNAMIC_NAMING_CLAIM_LEASE_SECONDS,
      })
      dynamicNamingClaimsTotal.inc({
        target_kind: params.targetKind,
        action: claim ? "claimed" : "stale",
        checkpoint: String(eligibility.checkpoint),
      })
      return claim
    })
  }

  async apply(
    params: TargetRef & {
      token: string
      expectedVersion: number
      titleRevision: number
      decision: DynamicNamingDecision
    }
  ) {
    return withTransaction(this.pool, async (client) => {
      const target = await this.targetAdapter.lockAndValidate(client, {
        ...params,
        expectedTitleRevision: params.titleRevision,
      })
      if (!target) {
        dynamicNamingDecisionsTotal.inc({
          target_kind: params.targetKind,
          action: `${params.decision.action}_protected`,
          checkpoint: "unknown",
        })
        return null
      }
      const state = await DynamicNamingStateRepository.find(
        client,
        params.workspaceId,
        params.targetKind,
        params.targetId
      )
      const checkpoint =
        state?.claimCheckpoint === null || state?.claimCheckpoint === undefined
          ? "unknown"
          : String(state.claimCheckpoint)
      const applied = await DynamicNamingStateRepository.applyDecision(client, params)
      let action = `${params.decision.action}_stale`
      if (applied) action = `${params.decision.action}_${applied.completedAt ? "settled" : "evaluated"}`
      dynamicNamingDecisionsTotal.inc({ target_kind: params.targetKind, action, checkpoint })
      return applied
    })
  }
}
