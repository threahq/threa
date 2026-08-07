import type { PoolClient } from "pg"
import { z } from "zod"
import { DYNAMIC_NAMING_CHECKPOINTS } from "./config"

export const DynamicNamingTargetKinds = ["stream", "conversation"] as const
export const DynamicNamingTargetKindSchema = z.enum(DynamicNamingTargetKinds)
export type DynamicNamingTargetKind = z.infer<typeof DynamicNamingTargetKindSchema>

export const DynamicNamingCheckpointSchema = z.union(DYNAMIC_NAMING_CHECKPOINTS.map((value) => z.literal(value)))
export type DynamicNamingCheckpoint = z.infer<typeof DynamicNamingCheckpointSchema>

export const DynamicNamingDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("defer") }),
  z.object({ action: z.literal("keep") }),
  z.object({ action: z.literal("rename"), title: z.string().trim().min(1) }),
])
export type DynamicNamingDecision = z.infer<typeof DynamicNamingDecisionSchema>

export const DynamicNamingEvaluateJobSchema = z.object({
  workspaceId: z.string().min(1),
  targetKind: DynamicNamingTargetKindSchema,
  targetId: z.string().min(1),
})
export type DynamicNamingEvaluateJobData = z.infer<typeof DynamicNamingEvaluateJobSchema>

export interface DynamicNamingTargetSnapshot {
  workspaceId: string
  targetKind: DynamicNamingTargetKind
  targetId: string
  messageCount: number
  titleRevision: number
}

export type DynamicNamingClaimReason = "ordinary" | "structural" | "regenerate"

export interface DynamicNamingTargetLockParams {
  workspaceId: string
  targetKind: DynamicNamingTargetKind
  targetId: string
  expectedTitleRevision?: number
}

export interface DynamicNamingTargetAdapter {
  lockAndValidate(
    client: PoolClient,
    params: DynamicNamingTargetLockParams
  ): Promise<DynamicNamingTargetSnapshot | null>
}

export interface DynamicNamingDecisionProvider {
  decide(
    target: DynamicNamingTargetSnapshot,
    checkpoint: DynamicNamingCheckpoint,
    forced: boolean
  ): Promise<DynamicNamingDecision>
}

export interface DynamicNamingJobScheduler {
  schedule(data: DynamicNamingEvaluateJobData, processAfter?: Date): Promise<void>
}
