import { describe, expect, it } from "bun:test"
import type { Message } from "../../messaging"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../../e2e-streams"
import type { EnclaveRuntime } from "../repository"
import { buildEnclaveInvokeRequest, type BuildInvokeInputs } from "./request-builder"

const E2E: E2eStream = {
  streamId: "stream_1",
  workspaceId: "ws_1",
  enabledAt: new Date(),
  ownerUserId: "usr_owner",
  ownerUserKeyId: "e2ek_owner",
  currentKeyGeneration: 1,
}

const ENCLAVE_ACTOR: E2eStreamActor = { kind: "enclave", actorId: "enclave", keyId: null }

function eik(keyId: string, instanceUrl: string): EnclaveRuntime {
  return {
    id: `elr_${keyId}`,
    instanceId: `enci_${keyId}`,
    keyId,
    publicKey: new Uint8Array([1, 2, 3]),
    instanceUrl,
    registeredAt: new Date(),
    lastSeenAt: new Date(),
    revokedAt: null,
  }
}

function wrap(keyId: string, gen: number): StreamE2eKeyWrap {
  return {
    keyGeneration: gen,
    recipientKeyId: keyId,
    recipientKind: "enclave",
    wrapEnc: `enc_${keyId}_${gen}`,
    wrapCt: `ct_${keyId}_${gen}`,
  }
}

function msg(id: string, authorType: "user" | "persona", text: string, gen = 1): Message {
  return {
    id,
    authorType,
    ciphertext: Buffer.from(`cipher:${text}`),
    envelope: { v: 2, keyGeneration: gen, iv: "aXY=", aad: "YWFk" },
  } as unknown as Message
}

const PERSONA = {
  systemPrompt: "You are Ariadne.",
  model: "openrouter:anthropic/claude-sonnet-4.6",
  temperature: 0.7,
  maxTokens: null,
}

function inputs(over: Partial<BuildInvokeInputs> = {}): BuildInvokeInputs {
  return {
    e2e: E2E,
    actors: [ENCLAVE_ACTOR],
    liveEiks: [eik("eik_live", "https://enclave-1.internal")],
    wraps: [wrap("eik_live", 1)],
    trigger: msg("msg_trigger", "user", "hello"),
    priorMessages: [],
    persona: PERSONA,
    replySenderId: "persona_ariadne",
    ...over,
  }
}

describe("buildEnclaveInvokeRequest", () => {
  it("builds a request to the EIK that can decrypt the current generation, stripping the model prefix", () => {
    const built = buildEnclaveInvokeRequest(inputs())
    expect(built).not.toBeNull()
    expect(built!.instanceUrl).toBe("https://enclave-1.internal")
    expect(built!.request.model).toBe("anthropic/claude-sonnet-4.6")
    expect(built!.request.system).toBe("You are Ariadne.")
    expect(built!.request.temperature).toBe(0.7)
    expect(built!.request).not.toHaveProperty("maxTokens") // null → omitted
    expect(built!.request.reply).toEqual({ keyGeneration: 1, senderId: "persona_ariadne" })
    expect(built!.request.prompt.ciphertext).toBe(Buffer.from("cipher:hello").toString("base64"))
    expect(built!.request.wraps).toEqual([{ keyGeneration: 1, wrapEnc: "enc_eik_live_1", wrapCt: "ct_eik_live_1" }])
  })

  it("returns null when no enclave actor is invited", () => {
    expect(buildEnclaveInvokeRequest(inputs({ actors: [{ kind: "bot", actorId: "bot_x", keyId: null }] }))).toBeNull()
  })

  it("returns null when no live EIK has a wrap for the current generation", () => {
    // Live EIK exists, but its only wrap is for an older generation.
    const built = buildEnclaveInvokeRequest(inputs({ wraps: [wrap("eik_live", 0)] }))
    expect(built).toBeNull()
  })

  it("picks a live EIK that has the current-generation wrap over one that doesn't", () => {
    const built = buildEnclaveInvokeRequest(
      inputs({
        liveEiks: [eik("eik_stale", "https://stale.internal"), eik("eik_fresh", "https://fresh.internal")],
        wraps: [wrap("eik_stale", 0), wrap("eik_fresh", 1)],
      })
    )
    expect(built!.instanceUrl).toBe("https://fresh.internal")
    expect(built!.request.wraps.every((w) => w.wrapEnc.includes("eik_fresh"))).toBe(true)
  })

  it("requires the chosen EIK to open the trigger generation too (rotated-key case)", () => {
    // Stream rotated to gen 1 after the user turn (sealed under gen 0) was stored.
    const trigger = msg("msg_trigger", "user", "hello", 0)

    // EIK wrapped only at the current gen (1) can seal the reply but can't open
    // the gen-0 prompt → no dispatch.
    expect(buildEnclaveInvokeRequest(inputs({ trigger, wraps: [wrap("eik_live", 1)] }))).toBeNull()

    // EIK wrapped at both generations → dispatch succeeds and ships both wraps.
    const built = buildEnclaveInvokeRequest(inputs({ trigger, wraps: [wrap("eik_live", 0), wrap("eik_live", 1)] }))
    expect(built).not.toBeNull()
    expect(built!.request.wraps.map((w) => w.keyGeneration).sort()).toEqual([0, 1])
    expect(built!.request.reply.keyGeneration).toBe(1) // reply still seals under current
  })

  it("maps prior messages to roles and drops non-E2E rows", () => {
    const plaintext = { id: "msg_plain", authorType: "user", ciphertext: null, envelope: null } as unknown as Message
    const built = buildEnclaveInvokeRequest(
      inputs({
        priorMessages: [msg("msg_a", "user", "q"), msg("msg_b", "persona", "a"), plaintext],
      })
    )
    expect(built!.request.history.map((h) => h.role)).toEqual(["user", "assistant"]) // plaintext dropped
  })
})
