import { z } from "zod"

const checkpointSchema = z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(10)])
const envelopeSchema = z
  .object({
    v: z.number(),
    keyGeneration: z.number().int().min(0),
    iv: z.string().min(1),
    aad: z.string().min(1),
  })
  .strict()
const sealedTitleSchema = z.object({ ciphertext: z.string().min(1), envelope: envelopeSchema }).strict()
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
