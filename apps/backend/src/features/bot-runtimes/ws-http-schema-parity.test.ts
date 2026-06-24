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

// One object comparison per case (INV-24): assert the WS and HTTP results are
// the SAME value, so a parity break surfaces as a single readable `{ ws, http }`
// diff rather than a chain of narrow booleans.
const parity = (ws: unknown, http: unknown, expected: unknown) =>
  expect({ ws, http }).toEqual({ ws: expected, http: expected })

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
      parity(wsStep({ clientStepId: "key-1" }).success, httpStep({ clientStepId: "key-1" }).success, true)
      parity(wsStep({}).success, httpStep({}).success, true) // optional on both
      const tooLong = "x".repeat(129)
      parity(wsStep({ clientStepId: tooLong }).success, httpStep({ clientStepId: tooLong }).success, false)
    })

    it("rejects empty content and unknown stepType identically", () => {
      parity(wsStep({ content: "" }).success, httpStep({ content: "" }).success, false)
      parity(wsStep({ stepType: "bogus" }).success, httpStep({ stepType: "bogus" }).success, false)
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
      parity(ws.success && ws.data.claimTtlSeconds, http.success && http.data.claimTtlSeconds, 60)
    })

    it("enforces the same 15..300 bounds on both", () => {
      parity(wsRenew({ claimTtlSeconds: 14 }).success, httpRenew({ claimTtlSeconds: 14 }).success, false)
      parity(wsRenew({ claimTtlSeconds: 301 }).success, httpRenew({ claimTtlSeconds: 301 }).success, false)
    })
  })

  describe("presence: runtimeKind / status / acceptingInvocations", () => {
    const base = { runtimeKind: "pi-local", instanceId: "inst", status: "busy", acceptingInvocations: false }

    it("accepts a valid body on both", () => {
      parity(presenceUpdateSchema.safeParse(base).success, upsertPresenceSchema.safeParse(base).success, true)
    })

    it("rejects an unknown status and a missing acceptingInvocations on both", () => {
      const badStatus = { ...base, status: "bogus" }
      parity(
        presenceUpdateSchema.safeParse(badStatus).success,
        upsertPresenceSchema.safeParse(badStatus).success,
        false
      )
      const { acceptingInvocations: _omit, ...noAccepting } = base
      parity(
        presenceUpdateSchema.safeParse(noAccepting).success,
        upsertPresenceSchema.safeParse(noAccepting).success,
        false
      )
    })
  })
})
