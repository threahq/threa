import { describe, expect, it } from "bun:test"
import { presenceUpdateSchema, invocationRenewSchema, invocationStepFrameSchema } from "./socket-handler"
import { upsertPresenceSchema, renewInvocationClaimSchema, recordInvocationStepSchema } from "../public-api/schemas"

// The `/bot` WebSocket frame schemas deliberately duplicate the HTTP body schemas
// (importing the HTTP ones into bot-runtimes would create a value cycle back into
// public-api). Shared `@threa/types` enums already prevent enum drift; this test
// is the guard against FIELD-level drift — a field tightened/loosened/added on one
// side but not the other. Asserted only on the genuinely-shared fields; instanceId
// is intentionally stricter on the WS side (it becomes a Socket.IO room segment),
// so it is excluded.

describe("WS ↔ HTTP schema parity", () => {
  describe("step: stepType / content / clientStepId", () => {
    const wsStep = (over: Record<string, unknown>) =>
      invocationStepFrameSchema.safeParse({ stepType: "thinking", content: "x", ...over })
    const httpStep = (over: Record<string, unknown>) =>
      recordInvocationStepSchema.safeParse({
        instanceId: "inst",
        claimToken: "tok",
        stepType: "thinking",
        content: "x",
        ...over,
      })

    it("accepts and bounds clientStepId identically (the recently-added field)", () => {
      expect(wsStep({ clientStepId: "key-1" }).success).toBe(true)
      expect(httpStep({ clientStepId: "key-1" }).success).toBe(true)
      // optional on both
      expect(wsStep({}).success).toBe(true)
      expect(httpStep({}).success).toBe(true)
      // >128 rejected on both
      const tooLong = "x".repeat(129)
      expect(wsStep({ clientStepId: tooLong }).success).toBe(false)
      expect(httpStep({ clientStepId: tooLong }).success).toBe(false)
    })

    it("rejects empty content and unknown stepType identically", () => {
      expect(wsStep({ content: "" }).success).toBe(false)
      expect(httpStep({ content: "" }).success).toBe(false)
      expect(wsStep({ stepType: "bogus" }).success).toBe(false)
      expect(httpStep({ stepType: "bogus" }).success).toBe(false)
    })
  })

  describe("renew: claimTtlSeconds default + bounds", () => {
    const wsRenew = (over: Record<string, unknown>) =>
      invocationRenewSchema.safeParse({ invocationId: "binv_1", instanceId: "inst", claimToken: "tok", ...over })
    const httpRenew = (over: Record<string, unknown>) =>
      renewInvocationClaimSchema.safeParse({ instanceId: "inst", claimToken: "tok", ...over })

    it("defaults claimTtlSeconds to 60 on both", () => {
      const ws = wsRenew({})
      const http = httpRenew({})
      expect(ws.success && ws.data.claimTtlSeconds).toBe(60)
      expect(http.success && http.data.claimTtlSeconds).toBe(60)
    })

    it("enforces the same 15..300 bounds on both", () => {
      expect(wsRenew({ claimTtlSeconds: 14 }).success).toBe(false)
      expect(httpRenew({ claimTtlSeconds: 14 }).success).toBe(false)
      expect(wsRenew({ claimTtlSeconds: 301 }).success).toBe(false)
      expect(httpRenew({ claimTtlSeconds: 301 }).success).toBe(false)
    })
  })

  describe("presence: runtimeKind / status / acceptingInvocations", () => {
    const base = { runtimeKind: "pi-local", instanceId: "inst", status: "busy", acceptingInvocations: false }

    it("accepts a valid body on both", () => {
      expect(presenceUpdateSchema.safeParse(base).success).toBe(true)
      expect(upsertPresenceSchema.safeParse(base).success).toBe(true)
    })

    it("rejects an unknown status and a missing acceptingInvocations on both", () => {
      expect(presenceUpdateSchema.safeParse({ ...base, status: "bogus" }).success).toBe(false)
      expect(upsertPresenceSchema.safeParse({ ...base, status: "bogus" }).success).toBe(false)
      const { acceptingInvocations: _omit, ...noAccepting } = base
      expect(presenceUpdateSchema.safeParse(noAccepting).success).toBe(false)
      expect(upsertPresenceSchema.safeParse(noAccepting).success).toBe(false)
    })
  })
})
