import { describe, expect, it } from "bun:test"
import type { Message } from "../messaging"
import type { E2eStream, StreamE2eKeyWrap } from "../e2e-streams"
import {
  buildSealedInputUpdate,
  buildSealedTurnContext,
  type BuildSealedTurnContextInputs,
} from "./sealed-turn-context"

const E2E: E2eStream = {
  streamId: "stream_1",
  workspaceId: "ws_1",
  enabledAt: new Date(),
  ownerUserId: "usr_owner",
  ownerUserKeyId: "e2ek_owner",
  currentKeyGeneration: 1,
  hasSealedName: false,
}

function botWrap(keyId: string, gen: number): StreamE2eKeyWrap {
  return {
    keyGeneration: gen,
    recipientKeyId: keyId,
    recipientKind: "bot",
    wrapEnc: `enc_${keyId}_${gen}`,
    wrapCt: `ct_${keyId}_${gen}`,
  }
}

let seq = 0n
function msg(id: string, authorId: string, text: string, gen = 1): Message {
  return {
    id,
    authorType: authorId.startsWith("bot_") ? "bot" : "user",
    authorId,
    sequence: ++seq,
    createdAt: new Date("2026-06-02T09:27:00.000Z"),
    ciphertext: Buffer.from(`cipher:${text}`),
    envelope: { v: 2, keyGeneration: gen, iv: "aXY=", aad: "YWFk" },
  } as unknown as Message
}

function inputs(over: Partial<BuildSealedTurnContextInputs> = {}): BuildSealedTurnContextInputs {
  return {
    e2e: E2E,
    bikKeyId: "bik_live",
    wraps: [botWrap("bik_live", 1)],
    trigger: msg("msg_trigger", "usr_kris", "hello"),
    triggerAuthorName: "Kris",
    priorMessages: [],
    replySenderId: "bot_pi",
    callbackToken: "cbtok_test",
    ...over,
  }
}

describe("buildSealedInputUpdate", () => {
  it("returns only current trigger material, addressed bot wraps, and reply binding", () => {
    const trigger = msg("msg_trigger", "usr_kris", "secret", 0)
    const update = buildSealedInputUpdate({
      e2e: E2E,
      bikKeyId: "bik_live",
      wraps: [
        botWrap("bik_live", 0),
        botWrap("bik_live", 1),
        botWrap("bik_other", 1),
        { ...botWrap("bik_live", 1), recipientKind: "enclave" },
      ],
      trigger,
      replySenderId: "bot_pi",
      sourceRevision: 3,
    })
    expect(update).toEqual({
      delivery: "sealed",
      sourceRevision: 3,
      prompt: {
        ciphertext: Buffer.from("cipher:secret").toString("base64"),
        envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
      },
      wraps: [
        { keyGeneration: 0, wrapEnc: "enc_bik_live_0", wrapCt: "ct_bik_live_0" },
        { keyGeneration: 1, wrapEnc: "enc_bik_live_1", wrapCt: "ct_bik_live_1" },
      ],
      reply: { keyGeneration: 1, senderId: "bot_pi" },
    })
    expect(update).not.toHaveProperty("promptMarkdown")
    expect(update).not.toHaveProperty("mentionedActorSlugs")
  })

  it("requires coverage for both trigger and reply generations", () => {
    const trigger = msg("msg_trigger", "usr_kris", "secret", 0)
    expect(
      buildSealedInputUpdate({
        e2e: E2E,
        bikKeyId: "bik_live",
        wraps: [botWrap("bik_live", 1)],
        trigger,
        replySenderId: "bot_pi",
        sourceRevision: 2,
      })
    ).toBeNull()
  })
})

describe("buildSealedTurnContext", () => {
  it("builds the sealed context for the claiming BIK", () => {
    const ctx = buildSealedTurnContext(inputs())
    expect(ctx).toMatchObject({
      callbackToken: "cbtok_test",
      reply: { keyGeneration: 1, senderId: "bot_pi" },
      prompt: { ciphertext: Buffer.from("cipher:hello").toString("base64") },
      wraps: [{ keyGeneration: 1, wrapEnc: "enc_bik_live_1", wrapCt: "ct_bik_live_1" }],
      trigger: { messageId: "msg_trigger", authorName: "Kris", authorType: "user" },
    })
  })

  it("is leaner than the enclave assignment — the bot owns its own model and prompt", () => {
    const ctx = buildSealedTurnContext(inputs())!
    // The bot runs its own agent loop, so the server never ships these.
    expect(ctx).not.toHaveProperty("system")
    expect(ctx).not.toHaveProperty("model")
    expect(ctx).not.toHaveProperty("temperature")
    expect(ctx).not.toHaveProperty("maxTokens")
  })

  it("omits the trigger metadata when the author name can't be resolved", () => {
    expect(buildSealedTurnContext(inputs({ triggerAuthorName: undefined }))).not.toHaveProperty("trigger")
  })

  it("returns null when the trigger isn't sealed", () => {
    const plaintextTrigger = {
      id: "msg_t",
      authorId: "usr_kris",
      ciphertext: null,
      envelope: null,
    } as unknown as Message
    expect(buildSealedTurnContext(inputs({ trigger: plaintextTrigger }))).toBeNull()
  })

  it("returns null when the claiming BIK has no wrap for the current generation", () => {
    // The claim predicate normally filters this out; the build re-checks the
    // revoke/rotation race. Only an older-generation wrap exists.
    expect(buildSealedTurnContext(inputs({ wraps: [botWrap("bik_live", 0)] }))).toBeNull()
  })

  it("ships only the claiming BIK's wraps, never another instance's", () => {
    const ctx = buildSealedTurnContext(inputs({ wraps: [botWrap("bik_other", 1), botWrap("bik_live", 1)] }))
    expect(ctx!.wraps.every((w) => w.wrapEnc.includes("bik_live"))).toBe(true)
  })

  it("ignores non-bot wraps even at the same key id and generation", () => {
    // An enclave (or user) wrap addressed to the same id must never satisfy a
    // bot claim — only `recipient_kind = 'bot'` wraps count.
    const enclaveWrap: StreamE2eKeyWrap = { ...botWrap("bik_live", 1), recipientKind: "enclave" }
    expect(buildSealedTurnContext(inputs({ wraps: [enclaveWrap] }))).toBeNull()
  })

  it("requires the claiming BIK to open the trigger generation too (rotated-key case)", () => {
    // Stream rotated to gen 1 after the user turn (sealed under gen 0) was stored.
    const trigger = msg("msg_trigger", "usr_kris", "hello", 0)

    // BIK wrapped only at the current gen (1) can seal the reply but can't open
    // the gen-0 prompt → unservable.
    expect(buildSealedTurnContext(inputs({ trigger, wraps: [botWrap("bik_live", 1)] }))).toBeNull()

    // BIK wrapped at both generations → the context ships both wraps.
    const ctx = buildSealedTurnContext(inputs({ trigger, wraps: [botWrap("bik_live", 0), botWrap("bik_live", 1)] }))
    expect(ctx).not.toBeNull()
    expect(ctx!.wraps.map((w) => w.keyGeneration).sort()).toEqual([0, 1])
    expect(ctx!.reply.keyGeneration).toBe(1) // reply still seals under current
  })

  it("keeps older-generation wraps needed only by encrypted history", () => {
    const ctx = buildSealedTurnContext(
      inputs({
        wraps: [botWrap("bik_live", 0), botWrap("bik_live", 1)],
        priorMessages: [msg("msg_old", "usr_kris", "older", 0)],
      })
    )
    expect(ctx?.wraps.map((wrap) => wrap.keyGeneration)).toEqual([0, 1])
    expect(ctx?.history[0]?.envelope.keyGeneration).toBe(0)
  })

  it("maps prior messages to roles by author and drops non-E2E rows", () => {
    const plaintext = { id: "msg_plain", authorId: "usr_kris", ciphertext: null, envelope: null } as unknown as Message
    const ctx = buildSealedTurnContext(
      inputs({
        // The bot's own prior replies (authorId === replySenderId) are "assistant".
        priorMessages: [msg("msg_a", "usr_kris", "q"), msg("msg_b", "bot_pi", "a"), plaintext],
      })
    )
    expect(ctx!.history.map((h) => h.role)).toEqual(["user", "assistant"]) // plaintext dropped
  })
})
