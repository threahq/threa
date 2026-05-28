import { describe, expect, it } from "vitest"
import { utf8Decode, utf8Encode } from "../encoding"
import { buildMessageAad } from "../envelope"
import { exportPublicKey, generateKeyPair } from "../hpke"
import {
  buildWrapAad,
  generateStreamKey,
  openMessage,
  openMessageAsString,
  sealMessage,
  STREAM_ENVELOPE_VERSION,
  unwrapStreamKey,
  wrapStreamKey,
} from "../stream-key"

const MSG_AAD = buildMessageAad({ streamId: "stream_1", messageId: "msg_1", senderId: "usr_1" })
const WRAP_AAD = buildWrapAad({ streamId: "stream_1", keyGeneration: 1, recipientKeyId: "uik_alice" })

async function makeRecipient() {
  const pair = await generateKeyPair()
  const publicKey = await exportPublicKey(pair.publicKey)
  return { publicKey, privateKey: pair.privateKey }
}

describe("generateStreamKey", () => {
  it("returns a fresh 32-byte key each call", () => {
    const a = generateStreamKey()
    const b = generateStreamKey()
    expect(a).toHaveLength(32)
    expect(b).toHaveLength(32)
    expect(a).not.toEqual(b)
  })
})

describe("sealMessage / openMessage round-trip", () => {
  it("seals and opens a UTF-8 string payload under the SSK", async () => {
    const key = generateStreamKey()

    const { envelope, ciphertext } = await sealMessage({
      key,
      keyGeneration: 3,
      payload: "hello stream world",
      aad: MSG_AAD,
    })

    expect(envelope.v).toBe(STREAM_ENVELOPE_VERSION)
    expect(envelope.keyGeneration).toBe(3)

    const decoded = await openMessageAsString({ key, envelope, ciphertext })
    expect(decoded).toBe("hello stream world")
  })

  it("seals and opens a raw byte payload", async () => {
    const key = generateStreamKey()
    const payload = utf8Encode('{"contentMarkdown":"hi"}')

    const { envelope, ciphertext } = await sealMessage({ key, keyGeneration: 1, payload, aad: MSG_AAD })

    const opened = await openMessage({ key, envelope, ciphertext })
    expect(utf8Decode(opened)).toBe('{"contentMarkdown":"hi"}')
  })
})

describe("sealMessage / openMessage rejection paths", () => {
  it("rejects opening with the wrong SSK", async () => {
    const key = generateStreamKey()
    const wrongKey = generateStreamKey()
    const { envelope, ciphertext } = await sealMessage({ key, keyGeneration: 1, payload: "secret", aad: MSG_AAD })

    await expect(openMessage({ key: wrongKey, envelope, ciphertext })).rejects.toThrow()
  })

  it("rejects opening when the bound AAD is forged", async () => {
    const key = generateStreamKey()
    const { envelope, ciphertext } = await sealMessage({ key, keyGeneration: 1, payload: "tamper", aad: MSG_AAD })

    const tampered = { ...envelope, aad: btoa("stream_evil|msg_evil|usr_evil") }
    await expect(openMessage({ key, envelope: tampered, ciphertext })).rejects.toThrow()
  })

  it("rejects an envelope with an unknown protocol version", async () => {
    const key = generateStreamKey()
    const { envelope, ciphertext } = await sealMessage({ key, keyGeneration: 1, payload: "v", aad: MSG_AAD })

    await expect(openMessage({ key, envelope: { ...envelope, v: 99 }, ciphertext })).rejects.toThrow(
      /Unsupported stream envelope version/
    )
  })

  it("rejects sealing with a non-32-byte key", async () => {
    await expect(
      sealMessage({ key: new Uint8Array(16), keyGeneration: 1, payload: "x", aad: MSG_AAD })
    ).rejects.toThrow(/must be 32 bytes/)
  })

  it("rejects opening with a non-32-byte key", async () => {
    const key = generateStreamKey()
    const { envelope, ciphertext } = await sealMessage({ key, keyGeneration: 1, payload: "x", aad: MSG_AAD })

    await expect(openMessage({ key: new Uint8Array(16), envelope, ciphertext })).rejects.toThrow(/must be 32 bytes/)
  })

  it("rejects sealing with empty AAD", async () => {
    const key = generateStreamKey()
    await expect(sealMessage({ key, keyGeneration: 1, payload: "x", aad: new Uint8Array(0) })).rejects.toThrow(
      /aad must be non-empty/
    )
  })
})

describe("wrapStreamKey / unwrapStreamKey", () => {
  it("wraps the SSK to a recipient and unwraps it back", async () => {
    const key = generateStreamKey()
    const alice = await makeRecipient()

    const wrap = await wrapStreamKey({ key, recipientPublicKey: alice.publicKey, aad: WRAP_AAD })
    const recovered = await unwrapStreamKey({
      enc: wrap.enc,
      ct: wrap.ct,
      recipientPrivateKey: alice.privateKey,
      aad: WRAP_AAD,
    })

    expect(recovered).toEqual(key)
  })

  it("lets two distinct recipients each recover the same SSK and open a message", async () => {
    const key = generateStreamKey()
    const alice = await makeRecipient()
    const enclave = await makeRecipient()

    const aliceAad = buildWrapAad({ streamId: "stream_1", keyGeneration: 2, recipientKeyId: "uik_alice" })
    const enclaveAad = buildWrapAad({ streamId: "stream_1", keyGeneration: 2, recipientKeyId: "eik_live" })

    const aliceWrap = await wrapStreamKey({ key, recipientPublicKey: alice.publicKey, aad: aliceAad })
    const enclaveWrap = await wrapStreamKey({ key, recipientPublicKey: enclave.publicKey, aad: enclaveAad })

    const aliceKey = await unwrapStreamKey({
      enc: aliceWrap.enc,
      ct: aliceWrap.ct,
      recipientPrivateKey: alice.privateKey,
      aad: aliceAad,
    })
    const enclaveKey = await unwrapStreamKey({
      enc: enclaveWrap.enc,
      ct: enclaveWrap.ct,
      recipientPrivateKey: enclave.privateKey,
      aad: enclaveAad,
    })

    expect(aliceKey).toEqual(key)
    expect(enclaveKey).toEqual(key)

    const msgAad = buildMessageAad({ streamId: "stream_1", messageId: "msg_1", senderId: "usr_alice" })
    const { envelope, ciphertext } = await sealMessage({ key, keyGeneration: 2, payload: "shared secret", aad: msgAad })

    expect(await openMessageAsString({ key: aliceKey, envelope, ciphertext })).toBe("shared secret")
    expect(await openMessageAsString({ key: enclaveKey, envelope, ciphertext })).toBe("shared secret")
  })

  it("rejects unwrapping with the wrong recipient private key", async () => {
    const key = generateStreamKey()
    const alice = await makeRecipient()
    const mallory = await makeRecipient()

    const wrap = await wrapStreamKey({ key, recipientPublicKey: alice.publicKey, aad: WRAP_AAD })
    await expect(
      unwrapStreamKey({ enc: wrap.enc, ct: wrap.ct, recipientPrivateKey: mallory.privateKey, aad: WRAP_AAD })
    ).rejects.toThrow()
  })

  it("rejects unwrapping when the wrap AAD is repointed to a different slot", async () => {
    const key = generateStreamKey()
    const alice = await makeRecipient()

    const wrap = await wrapStreamKey({ key, recipientPublicKey: alice.publicKey, aad: WRAP_AAD })

    const relocated = buildWrapAad({ streamId: "stream_2", keyGeneration: 1, recipientKeyId: "uik_alice" })
    await expect(
      unwrapStreamKey({ enc: wrap.enc, ct: wrap.ct, recipientPrivateKey: alice.privateKey, aad: relocated })
    ).rejects.toThrow()
  })

  it("rejects wrapping a non-32-byte key", async () => {
    const alice = await makeRecipient()
    await expect(
      wrapStreamKey({ key: new Uint8Array(16), recipientPublicKey: alice.publicKey, aad: WRAP_AAD })
    ).rejects.toThrow(/must be 32 bytes/)
  })

  it("rejects wrapping with empty AAD", async () => {
    const key = generateStreamKey()
    const alice = await makeRecipient()
    await expect(wrapStreamKey({ key, recipientPublicKey: alice.publicKey, aad: new Uint8Array(0) })).rejects.toThrow(
      /aad must be non-empty/
    )
  })

  it("rejects unwrapping with empty AAD", async () => {
    const key = generateStreamKey()
    const alice = await makeRecipient()
    const wrap = await wrapStreamKey({ key, recipientPublicKey: alice.publicKey, aad: WRAP_AAD })
    await expect(
      unwrapStreamKey({ enc: wrap.enc, ct: wrap.ct, recipientPrivateKey: alice.privateKey, aad: new Uint8Array(0) })
    ).rejects.toThrow(/aad must be non-empty/)
  })
})

describe("buildWrapAad", () => {
  it("is deterministic for the same inputs", () => {
    const a = buildWrapAad({ streamId: "s1", keyGeneration: 1, recipientKeyId: "uik_1" })
    const b = buildWrapAad({ streamId: "s1", keyGeneration: 1, recipientKeyId: "uik_1" })
    expect(a).toEqual(b)
  })

  it("differs when any component differs", () => {
    const base = buildWrapAad({ streamId: "s1", keyGeneration: 1, recipientKeyId: "uik_1" })
    const diffStream = buildWrapAad({ streamId: "s2", keyGeneration: 1, recipientKeyId: "uik_1" })
    const diffGen = buildWrapAad({ streamId: "s1", keyGeneration: 2, recipientKeyId: "uik_1" })
    const diffRecipient = buildWrapAad({ streamId: "s1", keyGeneration: 1, recipientKeyId: "uik_2" })
    expect(diffStream).not.toEqual(base)
    expect(diffGen).not.toEqual(base)
    expect(diffRecipient).not.toEqual(base)
  })
})
