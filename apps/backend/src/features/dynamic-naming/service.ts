import type { Pool } from "pg"
import { TitleSources } from "@threa/types"
import { withTransaction } from "../../db"
import { dynamicNamingClaimsTotal, dynamicNamingDecisionsTotal } from "../../lib/observability/metrics"
import {
  DYNAMIC_NAMING_CLAIM_LEASE_SECONDS,
  DYNAMIC_NAMING_DECISION_TIMEOUT_MS,
  DYNAMIC_NAMING_QUIET_MS,
} from "./config"
import { getNamingEligibility } from "./policy"
import { DynamicNamingStateRepository, type DynamicNamingState } from "./state-repository"
import { DynamicNamingDecisionSchema } from "./types"
import type {
  DynamicNamingDecisionProvider,
  DynamicNamingJobScheduler,
  DynamicNamingTargetAdapter,
  DynamicNamingTargetKind,
  DynamicNamingTargetSnapshot,
} from "./types"

interface TargetRef {
  workspaceId: string
  targetKind: DynamicNamingTargetKind
  targetId: string
}

export type DynamicNamingEvaluationResult =
  | { status: "protected" | "ineligible" | "stale" | "missing" }
  | { status: "requeued"; processAfter: Date }
  | { status: "evaluated"; action: "defer" | "keep" | "rename"; revision: number | null }

function progressOf(state: DynamicNamingState) {
  return {
    lastEvaluatedMessageCount: state.lastEvaluatedMessageCount,
    consecutiveKeeps: state.consecutiveKeeps,
    completed: state.completedAt !== null,
    structureVersion: state.structureVersion,
    lastEvaluatedStructureVersion: state.lastEvaluatedStructureVersion,
  }
}

export class DynamicNamingService {
  constructor(
    private readonly pool: Pool,
    private readonly adapters: Map<DynamicNamingTargetKind, DynamicNamingTargetAdapter>,
    private readonly provider: DynamicNamingDecisionProvider,
    private readonly scheduler: DynamicNamingJobScheduler,
    private readonly now: () => Date = () => new Date()
  ) {}

  async recordStructuralEvent(ref: TargetRef, eventId: string): Promise<boolean> {
    const adapter = this.adapters.get(ref.targetKind)
    if (!adapter) return false
    const target = await withTransaction(this.pool, async (client) => {
      const snapshot = await adapter.lockAndValidate(client, ref)
      if (!snapshot) return null
      await DynamicNamingStateRepository.ensure(client, {
        ...ref,
        initialLastEvaluatedMessageCount:
          snapshot.title !== null && snapshot.titleSource === TitleSources.GENERATED ? 1 : 0,
      })
      const state = await DynamicNamingStateRepository.recordStructuralEvent(client, { ...ref, eventId })
      return state ? snapshot : null
    })
    if (!target) return false
    await this.scheduler.schedule(ref, this.quietDeadline(target) ?? this.now())
    return true
  }

  async evaluate(ref: TargetRef, ownerId: string): Promise<DynamicNamingEvaluationResult> {
    const adapter = this.adapters.get(ref.targetKind)
    if (!adapter) return { status: "protected" }

    const prepared = await withTransaction(this.pool, async (client) => {
      const target = await adapter.lockAndValidate(client, ref)
      if (!target) return { status: "protected" as const }
      const quietDeadline = this.quietDeadline(target)
      if (quietDeadline && quietDeadline > this.now()) {
        return { status: "requeue" as const, processAfter: quietDeadline }
      }

      const state = await DynamicNamingStateRepository.ensure(client, {
        ...ref,
        initialLastEvaluatedMessageCount:
          target.title !== null && target.titleSource === TitleSources.GENERATED ? 1 : 0,
      })
      const eligibility = getNamingEligibility(progressOf(state), target.messageCount)
      if (!eligibility.eligible) return { status: "ineligible" as const }
      if (state.claimToken && state.claimExpiresAt && state.claimExpiresAt > this.now()) {
        return { status: "requeue" as const, processAfter: state.claimExpiresAt }
      }

      const claim = await DynamicNamingStateRepository.claim(client, {
        ...ref,
        ownerId,
        checkpoint: eligibility.checkpoint,
        messageCount: target.messageCount,
        structureVersion: state.structureVersion,
        titleRevision: target.titleRevision,
        expectedVersion: state.version,
        leaseSeconds: DYNAMIC_NAMING_CLAIM_LEASE_SECONDS,
      })
      if (!claim) {
        return {
          status: "requeue" as const,
          processAfter: state.claimExpiresAt ?? new Date(this.now().getTime() + 1_000),
        }
      }
      return { status: "claimed" as const, target, claim, eligibility }
    })

    if (prepared.status === "protected") {
      dynamicNamingClaimsTotal.inc({ target_kind: ref.targetKind, action: "protected", checkpoint: "none" })
      return { status: "protected" }
    }
    if (prepared.status === "ineligible") return { status: "ineligible" }
    if (prepared.status === "requeue") {
      await this.scheduler.schedule(ref, prepared.processAfter)
      return { status: "requeued", processAfter: prepared.processAfter }
    }

    dynamicNamingClaimsTotal.inc({
      target_kind: ref.targetKind,
      action: "claimed",
      checkpoint: String(prepared.eligibility.checkpoint),
    })

    const context = await adapter.loadContext(prepared.target)
    if (!context) {
      await this.release(ref, prepared.claim.claimToken!, prepared.claim.version)
      return { status: "missing" }
    }

    const renewed = await DynamicNamingStateRepository.renewClaim(this.pool, {
      ...ref,
      token: prepared.claim.claimToken!,
      expectedVersion: prepared.claim.version,
      leaseSeconds: DYNAMIC_NAMING_CLAIM_LEASE_SECONDS,
    })
    if (!renewed) {
      await this.scheduler.schedule(ref, this.now())
      return { status: "stale" }
    }

    let decision
    try {
      decision = DynamicNamingDecisionSchema.parse(
        await this.provider.decide(
          {
            ...ref,
            checkpoint: prepared.eligibility.checkpoint,
            forced: prepared.eligibility.forced,
            messageCount: prepared.target.messageCount,
            currentTitle: prepared.target.title,
            context: context.context,
            existingTitles: context.existingTitles,
          },
          AbortSignal.timeout(DYNAMIC_NAMING_DECISION_TIMEOUT_MS)
        )
      )
      if (prepared.eligibility.forced && decision.action === "defer") {
        throw new Error("Dynamic naming may not defer a forced checkpoint")
      }
      if (prepared.target.title === null && decision.action === "keep") {
        throw new Error("Dynamic naming may not keep a missing title")
      }
    } catch (error) {
      await this.release(ref, renewed.claimToken!, renewed.version)
      throw error
    }

    const applied = await withTransaction(this.pool, async (client) => {
      const target = await adapter.lockAndValidate(client, {
        ...ref,
        expectedTitleRevision: prepared.target.titleRevision,
      })
      if (!target) {
        await DynamicNamingStateRepository.release(client, {
          ...ref,
          token: renewed.claimToken!,
          expectedVersion: renewed.version,
        })
        return null
      }

      const result = await DynamicNamingStateRepository.applyDecision(client, {
        ...ref,
        token: renewed.claimToken!,
        expectedVersion: renewed.version,
        titleRevision: prepared.target.titleRevision,
        decision,
      })
      if (!result) return null

      let revision: number | null = null
      if (decision.action === "rename") {
        revision = await adapter.applyRename(client, target, decision.title)
        if (revision === null) throw new Error("Dynamic naming title CAS failed after state claim was consumed")
      }
      return { state: result.state, target, revision }
    })

    if (!applied) {
      dynamicNamingDecisionsTotal.inc({
        target_kind: ref.targetKind,
        action: `${decision.action}_stale`,
        checkpoint: String(prepared.eligibility.checkpoint),
      })
      return { status: "stale" }
    }

    dynamicNamingDecisionsTotal.inc({
      target_kind: ref.targetKind,
      action: `${decision.action}_${applied.state.completedAt ? "settled" : "evaluated"}`,
      checkpoint: String(prepared.eligibility.checkpoint),
    })
    await this.scheduleFollowUp(ref, applied.state, applied.target)
    return { status: "evaluated", action: decision.action, revision: applied.revision }
  }

  private quietDeadline(target: DynamicNamingTargetSnapshot): Date | null {
    return target.latestMessageAt ? new Date(target.latestMessageAt.getTime() + DYNAMIC_NAMING_QUIET_MS) : null
  }

  private async scheduleFollowUp(
    ref: TargetRef,
    state: DynamicNamingState,
    target: DynamicNamingTargetSnapshot
  ): Promise<void> {
    if (!getNamingEligibility(progressOf(state), target.messageCount).eligible) return
    await this.scheduler.schedule(ref, this.quietDeadline(target) ?? this.now())
  }

  private async release(ref: TargetRef, token: string, expectedVersion: number): Promise<void> {
    await DynamicNamingStateRepository.release(this.pool, { ...ref, token, expectedVersion })
  }
}
