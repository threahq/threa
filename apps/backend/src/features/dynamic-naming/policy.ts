import { DYNAMIC_NAMING_CHECKPOINTS, DYNAMIC_NAMING_SETTLING_KEEPS } from "./config"
import type { DynamicNamingCheckpoint, DynamicNamingClaimReason, DynamicNamingDecision } from "./types"

export const DYNAMIC_NAMING_FRONTIER_ADVANCING_REASONS = [
  "ordinary",
  "regenerate",
] as const satisfies readonly DynamicNamingClaimReason[]

export function advancesMessageFrontier(reason: DynamicNamingClaimReason): boolean {
  return DYNAMIC_NAMING_FRONTIER_ADVANCING_REASONS.includes(
    reason as (typeof DYNAMIC_NAMING_FRONTIER_ADVANCING_REASONS)[number]
  )
}

export interface NamingProgress {
  lastEvaluatedMessageCount: number
  consecutiveKeeps: number
  completed: boolean
  structureVersion: number
  lastEvaluatedStructureVersion: number
}

export type NamingEligibility =
  | { eligible: false }
  | { eligible: true; checkpoint: DynamicNamingCheckpoint; forced: boolean; structural: boolean }

export function getNamingEligibility(progress: NamingProgress, messageCount: number): NamingEligibility {
  const structural = progress.structureVersion > progress.lastEvaluatedStructureVersion
  if (structural) {
    const checkpoint = highestCrossedCheckpoint(messageCount) ?? 1
    return { eligible: true, checkpoint, forced: true, structural: true }
  }
  if (progress.completed) return { eligible: false }
  const checkpoint = [...DYNAMIC_NAMING_CHECKPOINTS]
    .reverse()
    .find((candidate) => candidate <= messageCount && candidate > progress.lastEvaluatedMessageCount)
  if (checkpoint === undefined) return { eligible: false }
  return { eligible: true, checkpoint, forced: checkpoint >= 3, structural: false }
}

function highestCrossedCheckpoint(messageCount: number): DynamicNamingCheckpoint | undefined {
  return [...DYNAMIC_NAMING_CHECKPOINTS].reverse().find((checkpoint) => checkpoint <= messageCount)
}

export function reduceNamingProgress(
  progress: NamingProgress,
  eligibility: Extract<NamingEligibility, { eligible: true }>,
  decision: DynamicNamingDecision,
  messageCount: number,
  reason: DynamicNamingClaimReason = eligibility.structural ? "structural" : "ordinary"
): NamingProgress {
  if (decision.action === "defer" && (eligibility.forced || eligibility.checkpoint !== 1)) {
    throw new Error("Dynamic naming may defer only at checkpoint 1")
  }

  const structural = reason === "structural" || reason === "regenerate"
  let consecutiveKeeps = 0
  if (structural) consecutiveKeeps = decision.action === "rename" ? 0 : progress.consecutiveKeeps
  else if (decision.action === "keep") consecutiveKeeps = progress.consecutiveKeeps + 1
  return {
    ...progress,
    lastEvaluatedMessageCount: advancesMessageFrontier(reason)
      ? Math.max(messageCount, eligibility.checkpoint)
      : progress.lastEvaluatedMessageCount,
    consecutiveKeeps,
    completed: structural
      ? progress.completed
      : eligibility.checkpoint === 10 ||
        (decision.action === "keep" && consecutiveKeeps >= DYNAMIC_NAMING_SETTLING_KEEPS),
    lastEvaluatedStructureVersion: structural ? progress.structureVersion : progress.lastEvaluatedStructureVersion,
  }
}

export function resetNamingProgress(progress: NamingProgress): NamingProgress {
  return {
    ...progress,
    lastEvaluatedMessageCount: 0,
    consecutiveKeeps: 0,
    completed: false,
    structureVersion: progress.structureVersion + 1,
  }
}
