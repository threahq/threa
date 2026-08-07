import { z } from "zod"

export const ENCLAVE_NAMING_CHECKPOINTS = [1, 3, 6, 10] as const

const checkpointSchema = z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(10)])
const envelopeSchema = z
  .object({
    v: z
      .number()
      .int()
      .refine((value): boolean => value === 2, "Unsupported stream envelope version"),
    keyGeneration: z.number().int().min(0),
    iv: z.base64().min(1),
    aad: z.base64().min(1),
  })
  .strict()
const sealedTitleSchema = z.object({ ciphertext: z.base64().min(1), envelope: envelopeSchema }).strict()
const observedSchema = {
  confidence: z.number().min(0).max(1),
  observedStateRevision: z.number().int().min(0),
  observedTitleRevision: z.number().int().min(0),
  observedMessageCount: z.number().int().min(0),
  observedCheckpoint: checkpointSchema,
}

export const EnclaveNamingInstructionSchema = z
  .object({
    stateRevision: z.number().int().min(0),
    titleRevision: z.number().int().min(0),
    checkpoint: checkpointSchema,
    messageCount: z.number().int().min(0),
    forced: z.boolean(),
    reason: z.enum(["ordinary", "structural", "regenerate"]),
    currentSealedTitle: sealedTitleSchema.optional(),
  })
  .strict()

export const EnclaveNamingDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("defer"), ...observedSchema }).strict(),
  z.object({ action: z.literal("keep"), ...observedSchema }).strict(),
  z.object({ action: z.literal("rename"), ...observedSchema, sealedReplacement: sealedTitleSchema }).strict(),
])

export type EnclaveNamingInstruction = z.infer<typeof EnclaveNamingInstructionSchema>
export type EnclaveNamingDecision = z.infer<typeof EnclaveNamingDecisionSchema>
