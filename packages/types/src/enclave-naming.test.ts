import { describe, expect, test } from "bun:test"
import { EnclaveNamingDecisionSchema, EnclaveNamingInstructionSchema } from "./enclave-naming"

const observed = {
  confidence: 0.8,
  observedStateRevision: 4,
  observedTitleRevision: 2,
  observedMessageCount: 6,
  observedCheckpoint: 6 as const,
}
const sealed = {
  ciphertext: "Y3Q=",
  envelope: { v: 1, keyGeneration: 2, iv: "aXY=", aad: "YWFk" },
}

describe("enclave naming protocol", () => {
  test("accepts an opaque instruction", () => {
    expect(
      EnclaveNamingInstructionSchema.parse({
        stateRevision: 4,
        titleRevision: 2,
        checkpoint: 6,
        messageCount: 6,
        forced: true,
        reason: "ordinary",
        currentSealedTitle: sealed,
      })
    ).toBeTruthy()
  })

  test("keep and defer cannot smuggle a sealed replacement", () => {
    expect(
      EnclaveNamingDecisionSchema.safeParse({ action: "keep", ...observed, sealedReplacement: sealed }).success
    ).toBe(false)
    expect(
      EnclaveNamingDecisionSchema.safeParse({ action: "defer", ...observed, sealedReplacement: sealed }).success
    ).toBe(false)
  })

  test("rename requires a valid sealed replacement", () => {
    expect(EnclaveNamingDecisionSchema.safeParse({ action: "rename", ...observed }).success).toBe(false)
    expect(
      EnclaveNamingDecisionSchema.safeParse({ action: "rename", ...observed, sealedReplacement: sealed }).success
    ).toBe(true)
  })

  test("rejects unknown plaintext fields", () => {
    expect(
      EnclaveNamingInstructionSchema.safeParse({
        stateRevision: 1,
        titleRevision: 0,
        checkpoint: 1,
        messageCount: 1,
        forced: false,
        reason: "ordinary",
        currentTitle: "secret",
      }).success
    ).toBe(false)
  })
})
