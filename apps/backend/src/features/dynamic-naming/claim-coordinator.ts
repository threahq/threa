import type { Pool } from "pg"
import { withTransaction } from "../../db"
import { dynamicNamingClaimsTotal, dynamicNamingDecisionsTotal } from "../../lib/observability/metrics"
import { DYNAMIC_NAMING_CLAIM_LEASE_SECONDS, DYNAMIC_NAMING_DECISION_TIMEOUT_MS } from "./config"
import { getNamingEligibility } from "./policy"
import { DynamicNamingStateRepository } from "./state-repository"
import type {
  DynamicNamingCheckpoint,
  DynamicNamingDecision,
  DynamicNamingDecisionProvider,
  DynamicNamingTargetAdapter,
  DynamicNamingTargetKind,
  DynamicNamingTargetSnapshot,
} from "./types"

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

  async renew(params: TargetRef & { token: string; expectedVersion: number }) {
    return DynamicNamingStateRepository.renewClaim(this.pool, {
      ...params,
      leaseSeconds: DYNAMIC_NAMING_CLAIM_LEASE_SECONDS,
    })
  }

  decide(
    provider: DynamicNamingDecisionProvider,
    target: DynamicNamingTargetSnapshot,
    checkpoint: DynamicNamingCheckpoint,
    forced: boolean
  ): Promise<DynamicNamingDecision> {
    return provider.decide(target, checkpoint, forced, AbortSignal.timeout(DYNAMIC_NAMING_DECISION_TIMEOUT_MS))
  }

  async apply(
    params: TargetRef & {
      token: string
      expectedVersion: number
      titleRevision: number
      decision: DynamicNamingDecision
      checkpoint?: DynamicNamingCheckpoint
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
      const applied = await DynamicNamingStateRepository.applyDecision(client, params)
      const checkpoint = applied ? String(applied.consumedClaim.checkpoint) : String(params.checkpoint ?? "unknown")
      let action = `${params.decision.action}_stale`
      if (applied) action = `${params.decision.action}_${applied.state.completedAt ? "settled" : "evaluated"}`
      dynamicNamingDecisionsTotal.inc({ target_kind: params.targetKind, action, checkpoint })
      return applied?.state ?? null
    })
  }
}
