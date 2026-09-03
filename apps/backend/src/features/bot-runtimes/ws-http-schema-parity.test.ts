import { describe, expect, it } from "bun:test"
import {
  helloSchema,
  presenceUpdateSchema,
  invocationRenewSchema,
  invocationStepFrameSchema,
  sealedStepFrameSchema,
} from "./socket-handler"
import {
  upsertPresenceSchema,
  renewInvocationClaimSchema,
  recordInvocationStepSchema,
  recordSealedInvocationStepSchema,
} from "../public-api/schemas"

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

    it("accepts both nonnegative revision fields and rejects negative values on both", () => {
      const revisions = { knownSourceRevision: 2, restartRequiredRevision: 3 }
      parity(wsRenew(revisions).success, httpRenew(revisions).success, true)
      parity(wsRenew({ knownSourceRevision: -1 }).success, httpRenew({ knownSourceRevision: -1 }).success, false)
      parity(
        wsRenew({ restartRequiredRevision: -1 }).success,
        httpRenew({ restartRequiredRevision: -1 }).success,
        false
      )
    })
  })

  describe("sealed step: stepId / ciphertext / envelope / durationMs", () => {
    const validEnvelope = { v: 2, keyGeneration: 1, iv: "AA==", aad: "AA==" }
    const base = { stepId: "step_1", stepType: "tool_call", ciphertext: "AA==", envelope: validEnvelope }
    const wsSealed = (over: Record<string, unknown>) => sealedStepFrameSchema.safeParse({ ...base, ...over })
    const httpSealed = (over: Record<string, unknown>) =>
      recordSealedInvocationStepSchema.safeParse({ ...base, ...over })

    it("accepts the full frame identically (with and without optionals)", () => {
      parity(wsSealed({}).success, httpSealed({}).success, true)
      parity(
        wsSealed({ messageId: "msg_1", durationMs: 12 }).success,
        httpSealed({ messageId: "msg_1", durationMs: 12 }).success,
        true
      )
    })

    it("rejects non-base64 ciphertext, malformed envelope, and negative duration identically", () => {
      parity(wsSealed({ ciphertext: "not base64!" }).success, httpSealed({ ciphertext: "not base64!" }).success, false)
      const badEnvelope = { ...validEnvelope, keyGeneration: -1 }
      parity(wsSealed({ envelope: badEnvelope }).success, httpSealed({ envelope: badEnvelope }).success, false)
      parity(wsSealed({ durationMs: -1 }).success, httpSealed({ durationMs: -1 }).success, false)
      const tooLong = "x".repeat(129)
      parity(wsSealed({ stepId: tooLong }).success, httpSealed({ stepId: tooLong }).success, false)
    })
  })

  describe("manifest input mode", () => {
    const helloBase = {
      runtimeKind: "pi-local",
      instanceId: "inst",
      supportedCapabilities: ["active-scratchpad"],
    }
    const httpBase = {
      runtimeKind: "pi-local",
      instanceId: "inst",
      status: "available",
      acceptingInvocations: true,
    }
    const wsManifest = (manifest: unknown) => helloSchema.safeParse({ ...helloBase, manifest }).success
    const httpManifest = (manifest: unknown) => upsertPresenceSchema.safeParse({ ...httpBase, manifest }).success

    it("keeps omission, null, live, and restart behavior identical on real registration surfaces", () => {
      const output = { reply: true, trace: true, sources: false }
      for (const manifest of [
        undefined,
        null,
        { output },
        { output, input: { updates: "live" } },
        { output, input: { updates: "restart" } },
      ]) {
        parity(wsManifest(manifest), httpManifest(manifest), true)
      }
      const invalid = { output, input: { updates: "replace" } }
      parity(wsManifest(invalid), httpManifest(invalid), false)
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
