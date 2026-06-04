import { describe, expect, it } from "bun:test"
import type { Message } from "../../messaging"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../../e2e-streams"
import type { EnclaveRuntime } from "../repository"
import { buildEnclaveSessionAssignment, type BuildInvokeInputs } from "./request-builder"

const E2E: E2eStream = {
  streamId: "stream_1",
  workspaceId: "ws_1",
  enabledAt: new Date(),
  ownerUserId: "usr_owner",
  ownerUserKeyId: "e2ek_owner",
  currentKeyGeneration: 1,
  allowedToolCategories: null,
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
    authorId: "usr_kris",
    createdAt: new Date("2026-06-02T09:27:00.000Z"),
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
    triggerAuthorName: "Kris",
    priorMessages: [],
    persona: PERSONA,
    replySenderId: "persona_ariadne",
    sessionId: "session_test",
    ...over,
  }
}

describe("buildEnclaveSessionAssignment", () => {
  it("builds a request to the EIK that can decrypt the current generation, stripping the model prefix", () => {
    const built = buildEnclaveSessionAssignment(inputs())
    expect(built).toMatchObject({
      instanceUrl: "https://enclave-1.internal",
      keyId: "eik_live",
      assignment: {
        sessionId: "session_test",
        model: "anthropic/claude-sonnet-4.6", // openrouter: prefix stripped
        // The full system prompt is assembled upstream (buildEnclaveSystemPrompt)
        // and passed through here verbatim as persona.systemPrompt.
        system: "You are Ariadne.",
        temperature: 0.7,
        reply: { keyGeneration: 1, senderId: "persona_ariadne" },
        prompt: { ciphertext: Buffer.from("cipher:hello").toString("base64") },
        wraps: [{ keyGeneration: 1, wrapEnc: "enc_eik_live_1", wrapCt: "ct_eik_live_1" }],
        // Clear trigger metadata for the enclave's "Triggered by" CONTEXT step.
        trigger: { messageId: "msg_trigger", authorName: "Kris", authorType: "user" },
      },
    })
    expect(built!.assignment).not.toHaveProperty("maxTokens") // null → omitted
  })

  it("omits the trigger metadata when the author name can't be resolved", () => {
    const built = buildEnclaveSessionAssignment(inputs({ triggerAuthorName: undefined }))
    // No misleading "Unknown" placeholder row — the enclave suppresses the
    // CONTEXT "Triggered by" step entirely when there's no name.
    expect(built!.assignment).not.toHaveProperty("trigger")
  })

  it("returns null when no enclave actor is invited", () => {
    expect(
      buildEnclaveSessionAssignment(inputs({ actors: [{ kind: "bot", actorId: "bot_x", keyId: null }] }))
    ).toBeNull()
  })

  it("returns null when no live EIK has a wrap for the current generation", () => {
    // Live EIK exists, but its only wrap is for an older generation.
    const built = buildEnclaveSessionAssignment(inputs({ wraps: [wrap("eik_live", 0)] }))
    expect(built).toBeNull()
  })

  it("picks a live EIK that has the current-generation wrap over one that doesn't", () => {
    const built = buildEnclaveSessionAssignment(
      inputs({
        liveEiks: [eik("eik_stale", "https://stale.internal"), eik("eik_fresh", "https://fresh.internal")],
        wraps: [wrap("eik_stale", 0), wrap("eik_fresh", 1)],
      })
    )
    expect(built!.instanceUrl).toBe("https://fresh.internal")
    expect(built!.assignment.wraps.every((w) => w.wrapEnc.includes("eik_fresh"))).toBe(true)
  })

  it("requires the chosen EIK to open the trigger generation too (rotated-key case)", () => {
    // Stream rotated to gen 1 after the user turn (sealed under gen 0) was stored.
    const trigger = msg("msg_trigger", "user", "hello", 0)

    // EIK wrapped only at the current gen (1) can seal the reply but can't open
    // the gen-0 prompt → no dispatch.
    expect(buildEnclaveSessionAssignment(inputs({ trigger, wraps: [wrap("eik_live", 1)] }))).toBeNull()

    // EIK wrapped at both generations → dispatch succeeds and ships both wraps.
    const built = buildEnclaveSessionAssignment(inputs({ trigger, wraps: [wrap("eik_live", 0), wrap("eik_live", 1)] }))
    expect(built).not.toBeNull()
    expect(built!.assignment.wraps.map((w) => w.keyGeneration).sort()).toEqual([0, 1])
    expect(built!.assignment.reply.keyGeneration).toBe(1) // reply still seals under current
  })

  it("maps prior messages to roles and drops non-E2E rows", () => {
    const plaintext = { id: "msg_plain", authorType: "user", ciphertext: null, envelope: null } as unknown as Message
    const built = buildEnclaveSessionAssignment(
      inputs({
        priorMessages: [msg("msg_a", "user", "q"), msg("msg_b", "persona", "a"), plaintext],
      })
    )
    expect(built!.assignment.history.map((h) => h.role)).toEqual(["user", "assistant"]) // plaintext dropped
  })

  it("omits allowedToolCategories when the stream has no policy (unrestricted)", () => {
    const built = buildEnclaveSessionAssignment(inputs())
    expect(built!.assignment).not.toHaveProperty("allowedToolCategories")
  })

  it("carries the stream's tool-privacy policy onto the assignment", () => {
    const built = buildEnclaveSessionAssignment(inputs({ e2e: { ...E2E, allowedToolCategories: ["web"] } }))
    expect(built!.assignment.allowedToolCategories).toEqual(["web"])
  })

  it("ships an empty policy verbatim (no tools at all)", () => {
    const built = buildEnclaveSessionAssignment(inputs({ e2e: { ...E2E, allowedToolCategories: [] } }))
    expect(built!.assignment.allowedToolCategories).toEqual([])
  })
})
