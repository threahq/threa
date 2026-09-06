import type { PoolClient } from "pg"
import type { TitleSource } from "@threahq/types"
import { z } from "zod"
import { DYNAMIC_NAMING_CHECKPOINTS } from "./config"
export {
  DynamicNamingEvaluateJobSchema,
  DynamicNamingTargetKinds,
  DynamicNamingTargetKindSchema,
} from "../../lib/queue/dynamic-naming-contract"
import type { DynamicNamingEvaluateJobData, DynamicNamingTargetKind } from "../../lib/queue/dynamic-naming-contract"
export type { DynamicNamingEvaluateJobData, DynamicNamingTargetKind } from "../../lib/queue/dynamic-naming-contract"

export const DynamicNamingCheckpointSchema = z.union(DYNAMIC_NAMING_CHECKPOINTS.map((value) => z.literal(value)))
export type DynamicNamingCheckpoint = z.infer<typeof DynamicNamingCheckpointSchema>

export type DynamicNamingDecision = { action: "defer" } | { action: "keep" } | { action: "rename"; title: string }

export const DynamicNamingDecisionResponseSchema = z
  .object({
    action: z.enum(["defer", "keep", "rename"]),
    title: z.string().trim().max(100),
  })
  .strict()

export const DynamicNamingDecisionSchema: z.ZodType<DynamicNamingDecision> = z.discriminatedUnion("action", [
  z.object({ action: z.literal("defer") }).strict(),
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("rename"), title: z.string().trim().min(1).max(100) }).strict(),
])

export interface DynamicNamingTargetSnapshot {
  workspaceId: string
  targetKind: DynamicNamingTargetKind
  targetId: string
  messageCount: number
  latestMessageAt: Date | null
  title: string | null
  titleSource: TitleSource | null
  titleRevision: number
}

export interface DynamicNamingEvaluationInput {
  workspaceId: string
  targetKind: DynamicNamingTargetKind
  targetId: string
  checkpoint: DynamicNamingCheckpoint
  forced: boolean
  messageCount: number
  currentTitle: string | null
  context: string
  existingTitles: string[]
}

export interface DynamicNamingTargetContext {
  context: string
  existingTitles: string[]
}

export type DynamicNamingClaimReason = "ordinary" | "structural" | "regenerate"

export interface DynamicNamingTargetLockParams {
  workspaceId: string
  targetKind: DynamicNamingTargetKind
  targetId: string
  expectedTitleRevision?: number
}

export interface DynamicNamingTargetAdapter {
  resolveAuthorityStreamId(client: PoolClient, params: DynamicNamingTargetLockParams): Promise<string | null>
  lockAndValidate(
    client: PoolClient,
    params: DynamicNamingTargetLockParams
  ): Promise<DynamicNamingTargetSnapshot | null>
  loadContext(target: DynamicNamingTargetSnapshot): Promise<DynamicNamingTargetContext | null>
  applyRename(client: PoolClient, target: DynamicNamingTargetSnapshot, title: string): Promise<number | null>
}

export interface DynamicNamingDecisionProvider {
  decide(input: DynamicNamingEvaluationInput, signal: AbortSignal): Promise<DynamicNamingDecision>
}

export interface DynamicNamingJobScheduler {
  schedule(data: DynamicNamingEvaluateJobData, processAfter?: Date): Promise<void>
}
