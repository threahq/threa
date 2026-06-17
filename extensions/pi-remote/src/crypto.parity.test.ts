import { describe, expect, test } from "bun:test"
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import * as vendored from "./crypto"
// Canonical source of truth. Imported by relative path because `@threa/crypto`
// is a private workspace package that doesn't resolve from this standalone
// extension by its bare specifier. This file is a dev/CI drift guard — it never
// ships to the `~/.pi` install.
import * as canonical from "../../../packages/crypto/src/index"

// Wrap an SSK the way the owner's client does (`@threa/crypto`'s `wrapStreamKey`:
// HPKE-seal under the recipient's public key, bound by `buildWrapAad`). Built on
// the noble KEM so it runs under Bun — `canonical.wrapStreamKey` uses the native
// `@hpke/core` KEM, whose X25519 encap throws under Bun's WebCrypto. The two KEMs
// are the same RFC 9180 DHKEM(X25519) and are wire-interoperable.
const nobleSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})
async function wrapSskToKey(
  ssk: Uint8Array,
  recipientPublicKeyRaw: Uint8Array,
  aad: Uint8Array
): Promise<{ enc: Uint8Array; ct: Uint8Array }> {
  const recipient = await nobleSuite.kem.deserializePublicKey(
    recipientPublicKeyRaw.buffer.slice(
      recipientPublicKeyRaw.byteOffset,
      recipientPublicKeyRaw.byteOffset + recipientPublicKeyRaw.byteLength
    )
  )
  const sealed = await nobleSuite.seal({ recipientPublicKey: recipient }, ssk, aad)
  return { enc: new Uint8Array(sealed.enc), ct: new Uint8Array(sealed.ct) }
}

const STREAM_ID = "stream_01HZX"
const KEY_GENERATION = 3
const SENDER_ID = "bot_01HZY"
const RECIPIENT_KEY_ID = "bik_01HZZ"

describe("vendored crypto stays byte-compatible with @threa/crypto", () => {
  test("envelope/payload versions match", () => {
    expect(vendored.STREAM_ENVELOPE_VERSION).toBe(canonical.STREAM_ENVELOPE_VERSION)
    expect(vendored.E2E_PAYLOAD_VERSION).toBe(canonical.E2E_PAYLOAD_VERSION)
  })

  test("buildWrapAad produces identical bytes", () => {
    const parts = { streamId: STREAM_ID, keyGeneration: KEY_GENERATION, recipientKeyId: RECIPIENT_KEY_ID }
    expect(vendored.bytesToBase64(vendored.buildWrapAad(parts))).toBe(
      canonical.bytesToBase64(canonical.buildWrapAad(parts))
    )
  })

  test("buildMessageAad produces identical bytes", () => {
    const parts = { streamId: STREAM_ID, messageId: "msg_01HZA", senderId: SENDER_ID }
    expect(vendored.bytesToBase64(vendored.buildMessageAad(parts))).toBe(
      canonical.bytesToBase64(canonical.buildMessageAad(parts))
    )
  })

  test("a message sealed by one module opens with the other (both directions)", async () => {
    const ssk = canonical.generateStreamKey()
    const aad = canonical.buildMessageAad({ streamId: STREAM_ID, messageId: "msg_01HZB", senderId: SENDER_ID })
    const payload = "hello sealed world — ünïcödé ✓"

    const sealedByVendored = await vendored.sealMessage({ key: ssk, keyGeneration: KEY_GENERATION, payload, aad })
    const openedByCanonical = await canonical.openMessageAsString({
      key: ssk,
      envelope: sealedByVendored.envelope,
      ciphertext: sealedByVendored.ciphertext,
    })
    expect(openedByCanonical).toBe(payload)

    const sealedByCanonical = await canonical.sealMessage({ key: ssk, keyGeneration: KEY_GENERATION, payload, aad })
    const openedByVendored = await vendored.openMessageAsString({
      key: ssk,
      envelope: sealedByCanonical.envelope,
      ciphertext: sealedByCanonical.ciphertext,
    })
    expect(openedByVendored).toBe(payload)
  })

  test("the vendored unwrap recovers an SSK wrapped to its BIK", async () => {
    const ssk = canonical.generateStreamKey()
    const keyPair = await vendored.generateKeyPair()
    const publicKey = await vendored.exportPublicKey(keyPair.publicKey)
    const aad = vendored.buildWrapAad({
      streamId: STREAM_ID,
      keyGeneration: KEY_GENERATION,
      recipientKeyId: RECIPIENT_KEY_ID,
    })

    const wrap = await wrapSskToKey(ssk, publicKey, aad)
    const recovered = await vendored.unwrapStreamKey({
      enc: wrap.enc,
      ct: wrap.ct,
      recipientPrivateKey: keyPair.privateKey,
      aad,
    })
    expect(vendored.bytesToBase64(recovered)).toBe(canonical.bytesToBase64(ssk))
  })

  test("an exported/re-imported private key still unwraps (BIK persistence round-trip)", async () => {
    const ssk = canonical.generateStreamKey()
    const keyPair = await vendored.generateKeyPair()
    const publicKey = await vendored.exportPublicKey(keyPair.publicKey)
    const privateBytes = await vendored.exportPrivateKey(keyPair.privateKey)
    const reimported = await vendored.importRecipientPrivateKey(privateBytes)
    const aad = vendored.buildWrapAad({
      streamId: STREAM_ID,
      keyGeneration: KEY_GENERATION,
      recipientKeyId: RECIPIENT_KEY_ID,
    })

    const wrap = await wrapSskToKey(ssk, publicKey, aad)
    const recovered = await vendored.unwrapStreamKey({
      enc: wrap.enc,
      ct: wrap.ct,
      recipientPrivateKey: reimported,
      aad,
    })
    expect(vendored.bytesToBase64(recovered)).toBe(canonical.bytesToBase64(ssk))
  })

  test("sealed-payload serialize/parse matches the canonical wrapper", () => {
    // Bare markdown is byte-identical (no wrapper) in both.
    expect(vendored.serializeSealedPayload("plain body")).toBe(canonical.serializeSealedPayload("plain body"))
    expect(vendored.serializeSealedPayload("plain body")).toBe("plain body")

    const sources = [{ type: "web", title: "T", url: "https://example.com", snippet: "s" }]
    expect(vendored.serializeSealedPayload("body", { sources })).toBe(
      canonical.serializeSealedPayload("body", { sources })
    )

    const parsed = vendored.parseSealedPayload(canonical.serializeSealedPayload("body", { sources }))
    expect(parsed.contentMarkdown).toBe("body")
    expect(parsed.sources).toEqual(sources)
  })
})
