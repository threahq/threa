import { describe, expect, it } from "vitest"
import { decryptPayload, decryptPayloadAsString, encryptPayload, buildMessageAad, ENVELOPE_VERSION } from "../envelope"
import { exportPublicKey, generateKeyPair } from "../hpke"
import { utf8Decode, utf8Encode } from "../encoding"

async function makeRecipient(keyId: string) {
  const pair = await generateKeyPair()
  const publicKey = await exportPublicKey(pair.publicKey)
  return { keyId, publicKey, privateKey: pair.privateKey }
}

describe("envelope round-trip", () => {
  it("encrypts and decrypts a UTF-8 payload for a single recipient", async () => {
    const alice = await makeRecipient("e2ek_alice")
    const aad = buildMessageAad({ streamId: "stream_1", messageId: "msg_1", senderId: "usr_1" })

    const { envelope } = await encryptPayload({
      payload: "hello secret world",
      recipients: [{ recipientKeyId: alice.keyId, publicKey: alice.publicKey }],
      aad,
    })

    expect(envelope.v).toBe(ENVELOPE_VERSION)
    expect(envelope.recipients).toHaveLength(1)
    expect(envelope.recipients[0]!.recipientKeyId).toBe("e2ek_alice")

    const decoded = await decryptPayloadAsString({
      envelope,
      privateKey: alice.privateKey,
      recipientKeyId: "e2ek_alice",
    })
    expect(decoded).toBe("hello secret world")
  })

  it("delivers the same plaintext to every recipient when sealed to multiple keys", async () => {
    const alice = await makeRecipient("e2ek_alice")
    const bot = await makeRecipient("brk_pi")
    const aad = buildMessageAad({ streamId: "stream_1", messageId: "msg_1", senderId: "usr_1" })

    const { envelope } = await encryptPayload({
      payload: utf8Encode('{"contentMarkdown":"hi"}'),
      recipients: [
        { recipientKeyId: alice.keyId, publicKey: alice.publicKey },
        { recipientKeyId: bot.keyId, publicKey: bot.publicKey },
      ],
      aad,
    })

    expect(envelope.recipients).toHaveLength(2)

    const aliceBytes = await decryptPayload({
      envelope,
      privateKey: alice.privateKey,
      recipientKeyId: alice.keyId,
    })
    const botBytes = await decryptPayload({
      envelope,
      privateKey: bot.privateKey,
      recipientKeyId: bot.keyId,
    })
    expect(utf8Decode(aliceBytes)).toBe('{"contentMarkdown":"hi"}')
    expect(utf8Decode(botBytes)).toBe('{"contentMarkdown":"hi"}')
  })

  it("throws when no recipient entry matches the requested keyId", async () => {
    const alice = await makeRecipient("e2ek_alice")
    const stranger = await makeRecipient("e2ek_stranger")
    const aad = buildMessageAad({ streamId: "stream_1", messageId: "msg_1", senderId: "usr_1" })

    const { envelope } = await encryptPayload({
      payload: "no",
      recipients: [{ recipientKeyId: alice.keyId, publicKey: alice.publicKey }],
      aad,
    })

    await expect(
      decryptPayload({
        envelope,
        privateKey: stranger.privateKey,
        recipientKeyId: stranger.keyId,
      })
    ).rejects.toThrow(/not addressed/)
  })

  it("rejects decrypt when AAD is forged (envelope ID-binding tampered)", async () => {
    const alice = await makeRecipient("e2ek_alice")
    const aad = buildMessageAad({ streamId: "stream_1", messageId: "msg_1", senderId: "usr_1" })

    const { envelope } = await encryptPayload({
      payload: "tamper test",
      recipients: [{ recipientKeyId: alice.keyId, publicKey: alice.publicKey }],
      aad,
    })

    // Mutate the AAD stored in the envelope (simulating an attacker repointing
    // it at a different message). HPKE verifies AAD against what the sender
    // bound in, so this must fail.
    const tampered = {
      ...envelope,
      aad: btoa("stream_evil|msg_evil|usr_evil"),
    }
    await expect(
      decryptPayload({
        envelope: tampered,
        privateKey: alice.privateKey,
        recipientKeyId: alice.keyId,
      })
    ).rejects.toThrow()
  })

  it("rejects encrypting with zero recipients", async () => {
    await expect(
      encryptPayload({
        payload: "nope",
        recipients: [],
      })
    ).rejects.toThrow(/at least one recipient/)
  })

  it("rejects an envelope with an unknown protocol version", async () => {
    const alice = await makeRecipient("e2ek_alice")
    const { envelope } = await encryptPayload({
      payload: "v",
      recipients: [{ recipientKeyId: alice.keyId, publicKey: alice.publicKey }],
    })
    await expect(
      decryptPayload({
        envelope: { ...envelope, v: 99 },
        privateKey: alice.privateKey,
        recipientKeyId: alice.keyId,
      })
    ).rejects.toThrow(/Unsupported envelope version/)
  })
})

describe("buildMessageAad", () => {
  it("is deterministic for the same inputs", () => {
    const a = buildMessageAad({ streamId: "s1", messageId: "m1", senderId: "u1" })
    const b = buildMessageAad({ streamId: "s1", messageId: "m1", senderId: "u1" })
    expect(a).toEqual(b)
  })

  it("differs when any component differs", () => {
    const base = buildMessageAad({ streamId: "s1", messageId: "m1", senderId: "u1" })
    const diffStream = buildMessageAad({ streamId: "s2", messageId: "m1", senderId: "u1" })
    const diffMsg = buildMessageAad({ streamId: "s1", messageId: "m2", senderId: "u1" })
    const diffSender = buildMessageAad({ streamId: "s1", messageId: "m1", senderId: "u2" })
    expect(diffStream).not.toEqual(base)
    expect(diffMsg).not.toEqual(base)
    expect(diffSender).not.toEqual(base)
  })
})
