import { describe, expect, it } from "bun:test"
import { createRuntimeSessionSchema, upsertPresenceSchema } from "./schemas"

const BASE = {
  runtimeKind: "pi-local" as const,
  instanceId: "inst_42",
  status: "available" as const,
  acceptingInvocations: true,
}

describe("upsertPresenceSchema BIK registration", () => {
  it("accepts a valid 32-byte BIK pair", () => {
    const result = upsertPresenceSchema.safeParse({
      ...BASE,
      publicKey: Buffer.alloc(32, 3).toString("base64"),
      publicKeyId: "bik_abc12",
    })
    expect(result.success).toBe(true)
  })

  it("accepts presence with no BIK at all (non-E2E runtime)", () => {
    expect(upsertPresenceSchema.safeParse(BASE).success).toBe(true)
  })

  it("rejects a half-registered BIK (publicKey without publicKeyId)", () => {
    const result = upsertPresenceSchema.safeParse({ ...BASE, publicKey: Buffer.alloc(32).toString("base64") })
    expect(result.success).toBe(false)
  })

  it("rejects a half-registered BIK (publicKeyId without publicKey)", () => {
    const result = upsertPresenceSchema.safeParse({ ...BASE, publicKeyId: "bik_abc12" })
    expect(result.success).toBe(false)
  })

  it("rejects a publicKey that is not a 32-byte X25519 key", () => {
    const result = upsertPresenceSchema.safeParse({
      ...BASE,
      publicKey: Buffer.alloc(16).toString("base64"),
      publicKeyId: "bik_short",
    })
    expect(result.success).toBe(false)
  })
})

describe("createRuntimeSessionSchema runtimeKind", () => {
  const base = {
    instanceId: "inst_1",
    runtimeSessionId: "sess_1",
    displayName: "Claude Code - threa",
  }

  it("accepts the session-linking runtime kinds", () => {
    expect(createRuntimeSessionSchema.safeParse({ ...base, runtimeKind: "pi-local" }).success).toBe(true)
    expect(createRuntimeSessionSchema.safeParse({ ...base, runtimeKind: "claude-code-channel" }).success).toBe(true)
  })

  it("rejects link-free kinds that have no business creating a session", () => {
    expect(createRuntimeSessionSchema.safeParse({ ...base, runtimeKind: "openclaw" }).success).toBe(false)
    expect(createRuntimeSessionSchema.safeParse({ ...base, runtimeKind: "custom" }).success).toBe(false)
  })
})
