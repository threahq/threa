import { describe, expect, it } from "vitest"
import type { EnclaveSessionAssignment } from "@threa/types"
import { sessionAssignmentSchema } from "./assignment"

const BASE: EnclaveSessionAssignment = {
  sessionId: "session_test",
  callbackToken: "cbtok_1",
  streamId: "stream_x",
  wraps: [{ keyGeneration: 0, wrapEnc: "ZW5j", wrapCt: "Y3Q=" }],
  history: [],
  prompt: { ciphertext: "Y3Q=", envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" } },
  system: "You are Ariadne.",
  model: "anthropic/claude-sonnet-4.6",
  reply: { keyGeneration: 0, senderId: "persona_ariadne" },
}

// Every optional field here MUST be declared in the schema — Zod strips
// undeclared keys, and a silently dropped field is exactly how the first
// attachment slice shipped broken. These tests pin the retention.
describe("sessionAssignmentSchema", () => {
  it("parses a minimal assignment", () => {
    const parsed = sessionAssignmentSchema.safeParse(BASE)
    expect(parsed.success).toBe(true)
  })

  it("rejects an assignment without a prompt", () => {
    const { prompt: _prompt, ...rest } = BASE
    expect(sessionAssignmentSchema.safeParse(rest).success).toBe(false)
  })

  it("keeps callbackToken through parsing (a stripped token would break every session callback)", () => {
    const parsed = sessionAssignmentSchema.parse(BASE)
    expect(parsed.callbackToken).toBe("cbtok_1")
  })

  it("rejects an assignment without a callbackToken — a tokenless turn could never report a result", () => {
    const { callbackToken: _token, ...rest } = BASE
    expect(sessionAssignmentSchema.safeParse(rest).success).toBe(false)
  })

  it("keeps recentDigests through parsing", () => {
    const recentDigests = [
      {
        ciphertext: "ZGlnZXN0",
        envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
        completedAt: "2026-06-10T10:00:00.000Z",
      },
    ]
    const parsed = sessionAssignmentSchema.parse({ ...BASE, recentDigests })
    expect(parsed.recentDigests).toEqual(recentDigests)
  })

  it("keeps attachmentCiphertexts through parsing (the attachment-slice regression)", () => {
    const parsed = sessionAssignmentSchema.parse({
      ...BASE,
      attachmentCiphertexts: [{ attachmentId: "attach_1", ciphertext: "b64bytes" }],
    })
    expect(parsed.attachmentCiphertexts).toEqual([{ attachmentId: "attach_1", ciphertext: "b64bytes" }])
  })

  it("keeps allowedToolCategories through parsing, including the empty (no-tools) policy", () => {
    expect(sessionAssignmentSchema.parse({ ...BASE, allowedToolCategories: [] }).allowedToolCategories).toEqual([])
    expect(sessionAssignmentSchema.parse(BASE).allowedToolCategories).toBeUndefined()
  })
})
