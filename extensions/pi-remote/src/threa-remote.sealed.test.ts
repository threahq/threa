import { describe, expect, test } from "bun:test"
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  exportPublicKey,
  generateKeyPair,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
} from "./crypto"
import { __testing } from "./threa-remote"

// Exercises the sealed (E2E) turn path the way the backend + owner's client do:
// the owner wraps the stream key to the bot's BIK and seals the trigger/history;
// the harness opens it, runs a turn, and seals replies/steps back. Wraps use the
// noble KEM (Bun's WebCrypto can't X25519-encap) — interoperable with the owner's
// native KEM per RFC 9180.

const STREAM_ID = "stream_e2e_root"
const KEY_GEN = 0
const BOT_SENDER_ID = "bot_sealed"
const BIK_KEY_ID = "bik_test"

const nobleSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

async function makeIdentity() {
  const pair = await generateKeyPair()
  const publicKeyBase64 = bytesToBase64(await exportPublicKey(pair.publicKey))
  return { publicKeyId: BIK_KEY_ID, publicKeyBase64, privateKey: pair.privateKey }
}

async function wrapSskToIdentity(ssk: Uint8Array, identity: { publicKeyBase64: string; publicKeyId: string }) {
  const aad = buildWrapAad({ streamId: STREAM_ID, keyGeneration: KEY_GEN, recipientKeyId: identity.publicKeyId })
  const pub = base64ToBytes(identity.publicKeyBase64)
  const recipient = await nobleSuite.kem.deserializePublicKey(pub.buffer)
  const sealed = await nobleSuite.seal({ recipientPublicKey: recipient }, ssk, aad)
  return {
    keyGeneration: KEY_GEN,
    wrapEnc: bytesToBase64(new Uint8Array(sealed.enc)),
    wrapCt: bytesToBase64(new Uint8Array(sealed.ct)),
  }
}

async function sealMsg(ssk: Uint8Array, content: string, messageId: string, senderId: string) {
  const sealed = await sealMessage({
    key: ssk,
    keyGeneration: KEY_GEN,
    payload: content,
    aad: buildMessageAad({ streamId: STREAM_ID, messageId, senderId }),
  })
  return { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
}

async function buildSealedContext(extra?: { wraps?: unknown[] }) {
  const ssk = crypto.getRandomValues(new Uint8Array(32))
  const identity = await makeIdentity()
  const wrap = await wrapSskToIdentity(ssk, identity)
  const prompt = await sealMsg(ssk, "What is 2 + 2?", "msg_trigger", "user_alice")
  const hist = await sealMsg(ssk, "Some earlier context", "msg_hist", "user_alice")
  const sealed = {
    callbackToken: "cbtok_session_1",
    wraps: (extra?.wraps as (typeof wrap)[]) ?? [wrap],
    history: [{ ...hist, role: "user" as const, sequence: "1" }],
    prompt,
    reply: { keyGeneration: KEY_GEN, senderId: BOT_SENDER_ID },
    trigger: { messageId: "msg_trigger", authorName: "Alice", authorType: "user", createdAt: "2026-06-17T00:00:00Z" },
  }
  return { ssk, identity, sealed }
}

describe("sealed turn path", () => {
  test("opens a sealed claim: decrypts the trigger + history and exposes the reply key", async () => {
    const { identity, sealed } = await buildSealedContext()
    const { promptMarkdown, sealing } = await __testing.openSealedTurnContext(sealed, identity, STREAM_ID)

    expect(promptMarkdown).toBe("What is 2 + 2?")
    expect(sealing).toMatchObject({
      streamId: STREAM_ID,
      replyKeyGeneration: KEY_GEN,
      replySenderId: BOT_SENDER_ID,
      callbackToken: "cbtok_session_1",
    })
    // contextText is a substring check (it embeds decrypted history), not equality.
    expect(sealing.contextText).toContain("Some earlier context")
    expect(sealing.contextText).toContain("Recent Threa stream context")
  })

  test("fails loudly when no wrap covers the prompt's key generation", async () => {
    const { identity, sealed } = await buildSealedContext({ wraps: [] })
    await expect(__testing.openSealedTurnContext(sealed, identity, STREAM_ID)).rejects.toThrow(/no SSK wrap/i)
  })

  test("seals a reply bound to (streamId, messageId, senderId) that opens back to the markdown", async () => {
    const { identity, sealed } = await buildSealedContext()
    const { sealing } = await __testing.openSealedTurnContext(sealed, identity, STREAM_ID)

    const reply = await __testing.sealReplyWith(sealing, "The answer is 4.")
    expect(reply.messageId).toMatch(/^msg_/)
    expect(reply.envelope.keyGeneration).toBe(KEY_GEN)

    // The AAD is exactly what the owner's client reconstructs to open the reply.
    const expectedAad = buildMessageAad({ streamId: STREAM_ID, messageId: reply.messageId, senderId: BOT_SENDER_ID })
    expect(reply.envelope.aad).toBe(bytesToBase64(expectedAad))

    const opened = await openMessageAsString({
      key: sealing.replySsk,
      envelope: reply.envelope,
      ciphertext: base64ToBytes(reply.ciphertext),
    })
    expect(parseSealedPayload(opened).contentMarkdown).toBe("The answer is 4.")
  })

  test("seals a trace step under a step_ id, and drops an empty step", async () => {
    const { identity, sealed } = await buildSealedContext()
    const { sealing } = await __testing.openSealedTurnContext(sealed, identity, STREAM_ID)

    const step = await __testing.sealStepWith(sealing, "reasoning", "Considering the question")
    expect(step).not.toBeNull()
    expect(step!.stepId).toMatch(/^step_/)
    const expectedAad = buildMessageAad({ streamId: STREAM_ID, messageId: step!.stepId, senderId: BOT_SENDER_ID })
    expect(step).toMatchObject({ stepType: "reasoning", envelope: { aad: bytesToBase64(expectedAad) } })
    const opened = await openMessageAsString({
      key: sealing.replySsk,
      envelope: step!.envelope,
      ciphertext: base64ToBytes(step!.ciphertext),
    })
    expect(parseSealedPayload(opened).contentMarkdown).toBe("Considering the question")

    expect(await __testing.sealStepWith(sealing, "reasoning", "   ")).toBeNull()
  })

  test("scrubSealedError returns the class name only — never the message", () => {
    expect(__testing.scrubSealedError(new TypeError("contains decrypted secret"))).toBe("TypeError")
    expect(__testing.scrubSealedError("a raw string")).toBe("Error")
  })
})
