import { describe, expect, it } from "bun:test"
import type { Message } from "../../messaging"
import type { E2eStream, E2eStreamActor, StreamE2eKeyWrap } from "../../e2e-streams"
import { buildEnclaveSessionAssignment, type BuildInvokeInputs } from "./request-builder"

const E2E: E2eStream = {
  streamId: "stream_1",
  workspaceId: "ws_1",
  enabledAt: new Date(),
  ownerUserId: "usr_owner",
  ownerUserKeyId: "e2ek_owner",
  currentKeyGeneration: 1,
  hasSealedName: false,
}

const ENCLAVE_ACTOR: E2eStreamActor = { kind: "enclave", actorId: "enclave", keyId: null }

function wrap(keyId: string, gen: number): StreamE2eKeyWrap {
  return {
    keyGeneration: gen,
    recipientKeyId: keyId,
    recipientKind: "enclave",
    wrapEnc: `enc_${keyId}_${gen}`,
    wrapCt: `ct_${keyId}_${gen}`,
  }
}

let seq = 0n
function msg(id: string, authorType: "user" | "persona", text: string, gen = 1): Message {
  return {
    id,
    authorType,
    authorId: "usr_kris",
    sequence: ++seq,
    createdAt: new Date("2026-06-02T09:27:00.000Z"),
    ciphertext: Buffer.from(`cipher:${text}`),
    envelope: { v: 2, keyGeneration: gen, iv: "aXY=", aad: "YWFk" },
  } as unknown as Message
}

const PERSONA = {
  systemPrompt: "You are Ariadne.",
  systemVolatilePrompt: "",
  model: "openrouter:anthropic/claude-sonnet-4.6",
  temperature: 0.7,
  maxTokens: null,
}

function inputs(over: Partial<BuildInvokeInputs> = {}): BuildInvokeInputs {
  return {
    e2e: E2E,
    actors: [ENCLAVE_ACTOR],
    eikKeyId: "eik_live",
    wraps: [wrap("eik_live", 1)],
    trigger: msg("msg_trigger", "user", "hello"),
    triggerAuthorName: "Kris",
    priorMessages: [],
    persona: PERSONA,
    replySenderId: "persona_ariadne",
    sessionId: "session_test",
    callbackToken: "cbtok_test",
    allowedToolCategories: null,
    ...over,
  }
}

describe("buildEnclaveSessionAssignment", () => {
  it("builds the assignment for the claiming EIK, stripping the model prefix", () => {
    const assignment = buildEnclaveSessionAssignment(inputs())
    expect(assignment).toMatchObject({
      sessionId: "session_test",
      callbackToken: "cbtok_test",
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
    })
    expect(assignment).not.toHaveProperty("maxTokens") // null → omitted
  })

  it("ships both legacy autoTitle and opaque revision-fenced naming during rollout", () => {
    const naming = {
      stateRevision: 4,
      titleRevision: 2,
      checkpoint: 3 as const,
      messageCount: 3,
      forced: true,
      reason: "ordinary" as const,
      currentSealedTitle: {
        ciphertext: "Y3Q=",
        envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" },
      },
    }
    const assignment = buildEnclaveSessionAssignment(inputs({ autoTitle: true, naming }))
    expect(assignment).toMatchObject({ autoTitle: true, naming })
    expect(JSON.stringify(assignment)).not.toContain("currentTitle")
  })

  it("omits the trigger metadata when the author name can't be resolved", () => {
    const assignment = buildEnclaveSessionAssignment(inputs({ triggerAuthorName: undefined }))
    // No misleading "Unknown" placeholder row — the enclave suppresses the
    // CONTEXT "Triggered by" step entirely when there's no name.
    expect(assignment).not.toHaveProperty("trigger")
  })

  it("ships prior turns' sealed digests verbatim, and omits the field when there are none", () => {
    expect(buildEnclaveSessionAssignment(inputs())).not.toHaveProperty("recentDigests")
    expect(buildEnclaveSessionAssignment(inputs({ recentDigests: [] }))).not.toHaveProperty("recentDigests")

    const digest = {
      ciphertext: "ZGlnZXN0",
      envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" },
      completedAt: "2026-06-10T10:00:00.000Z",
    }
    const assignment = buildEnclaveSessionAssignment(inputs({ recentDigests: [digest] }))
    expect(assignment!.recentDigests).toEqual([digest])
  })

  it("ships the trigger's attachment ciphertext inline, and omits it when there's none", () => {
    expect(buildEnclaveSessionAssignment(inputs())).not.toHaveProperty("attachmentCiphertexts")

    const withFiles = buildEnclaveSessionAssignment(
      inputs({ attachmentCiphertexts: [{ attachmentId: "attach_1", ciphertext: "Y2lwaGVy" }] })
    )
    expect(withFiles!.attachmentCiphertexts).toEqual([{ attachmentId: "attach_1", ciphertext: "Y2lwaGVy" }])
  })

  it("returns null when no enclave actor is invited", () => {
    expect(
      buildEnclaveSessionAssignment(inputs({ actors: [{ kind: "bot", actorId: "bot_x", keyId: null }] }))
    ).toBeNull()
  })

  it("returns null when the claiming EIK has no wrap for the current generation", () => {
    // The claim predicate normally filters this out; the build re-checks the
    // revoke/rotation race. Only an older-generation wrap exists.
    expect(buildEnclaveSessionAssignment(inputs({ wraps: [wrap("eik_live", 0)] }))).toBeNull()
  })

  it("ships only the claiming EIK's wraps, never another instance's", () => {
    const assignment = buildEnclaveSessionAssignment(inputs({ wraps: [wrap("eik_other", 1), wrap("eik_live", 1)] }))
    expect(assignment!.wraps.every((w) => w.wrapEnc.includes("eik_live"))).toBe(true)
  })

  it("requires the claiming EIK to open the trigger generation too (rotated-key case)", () => {
    // Stream rotated to gen 1 after the user turn (sealed under gen 0) was stored.
    const trigger = msg("msg_trigger", "user", "hello", 0)

    // EIK wrapped only at the current gen (1) can seal the reply but can't open
    // the gen-0 prompt → unservable.
    expect(buildEnclaveSessionAssignment(inputs({ trigger, wraps: [wrap("eik_live", 1)] }))).toBeNull()

    // EIK wrapped at both generations → the assignment ships both wraps.
    const assignment = buildEnclaveSessionAssignment(
      inputs({ trigger, wraps: [wrap("eik_live", 0), wrap("eik_live", 1)] })
    )
    expect(assignment).not.toBeNull()
    expect(assignment!.wraps.map((w) => w.keyGeneration).sort()).toEqual([0, 1])
    expect(assignment!.reply.keyGeneration).toBe(1) // reply still seals under current
  })

  it("maps prior messages to roles and drops non-E2E rows", () => {
    const plaintext = { id: "msg_plain", authorType: "user", ciphertext: null, envelope: null } as unknown as Message
    const assignment = buildEnclaveSessionAssignment(
      inputs({
        priorMessages: [msg("msg_a", "user", "q"), msg("msg_b", "persona", "a"), plaintext],
      })
    )
    expect(assignment!.history.map((h) => h.role)).toEqual(["user", "assistant"]) // plaintext dropped
  })

  it("omits allowedToolCategories when the stream has no policy (unrestricted)", () => {
    expect(buildEnclaveSessionAssignment(inputs())).not.toHaveProperty("allowedToolCategories")
  })

  it("carries the stream's tool-privacy policy onto the assignment", () => {
    const assignment = buildEnclaveSessionAssignment(inputs({ allowedToolCategories: ["web"] }))
    expect(assignment!.allowedToolCategories).toEqual(["web"])
  })

  it("ships an empty policy verbatim (no tools at all)", () => {
    const assignment = buildEnclaveSessionAssignment(inputs({ allowedToolCategories: [] }))
    expect(assignment!.allowedToolCategories).toEqual([])
  })
})
