import { z } from "zod"

export const DynamicNamingTargetKinds = ["stream", "conversation"] as const
export const DynamicNamingTargetKindSchema = z.enum(DynamicNamingTargetKinds)
export type DynamicNamingTargetKind = z.infer<typeof DynamicNamingTargetKindSchema>

export const DynamicNamingEvaluateJobSchema = z.object({
  workspaceId: z.string().min(1),
  targetKind: DynamicNamingTargetKindSchema,
  targetId: z.string().min(1),
})
export type DynamicNamingEvaluateJobData = z.infer<typeof DynamicNamingEvaluateJobSchema>
