import { beforeEach, describe, expect, it } from "vitest"
import { base64ToBytes, bytesToBase64, openMessage, STREAM_ENVELOPE_VERSION, utf8Encode } from "@threa/crypto"
import {
  clearAttachmentRefCache,
  decryptAttachmentBytes,
  encryptAttachmentBytes,
  getAttachmentRef,
  rememberAttachmentRef,
  type AttachmentRef,
} from "../attachment-crypto"

beforeEach(() => clearAttachmentRefCache())

describe("encryptAttachmentBytes", () => {
  it("produces ciphertext the returned key/iv decrypt back to the original bytes", async () => {
    const plaintext = utf8Encode("the launch slipped to Q3 — keep it off Slack")
    const { ciphertext, key, iv } = await encryptAttachmentBytes(plaintext)

    // Opaque on the wire: the uploaded bytes are not the plaintext, and carry
    // the GCM tag so they're longer.
    expect(bytesToBase64(ciphertext)).not.toBe(bytesToBase64(plaintext))
    expect(ciphertext.length).toBeGreaterThan(plaintext.length)

    // Reconstruct the envelope exactly as the viewer (Slice B2) will: fixed
    // generation + the domain-separation AAD, with the per-file iv from the ref.
    const opened = await openMessage({
      key: base64ToBytes(key),
      envelope: {
        v: STREAM_ENVELOPE_VERSION,
        keyGeneration: 0,
        iv,
        aad: bytesToBase64(utf8Encode("threa-attachment-v1")),
      },
      ciphertext,
    })
    expect(bytesToBase64(opened)).toBe(bytesToBase64(plaintext))
  })

  it("mints a fresh key + iv per file so no key is ever reused", async () => {
    const a = await encryptAttachmentBytes(utf8Encode("a"))
    const b = await encryptAttachmentBytes(utf8Encode("b"))
    expect(a.key).not.toBe(b.key)
    expect(a.iv).not.toBe(b.iv)
  })
})

describe("decryptAttachmentBytes (the viewer inverse)", () => {
  it("round-trips: encrypt → decrypt with the ref's key/iv recovers the bytes", async () => {
    const plaintext = utf8Encode("the launch slipped to Q3 — keep it off Slack")
    const { ciphertext, key, iv } = await encryptAttachmentBytes(plaintext)

    const opened = await decryptAttachmentBytes({ ciphertext, key, iv })
    expect(bytesToBase64(opened)).toBe(bytesToBase64(plaintext))
  })

  it("throws on the wrong key (AES-GCM tag check), never returns garbage", async () => {
    const { ciphertext, iv } = await encryptAttachmentBytes(utf8Encode("secret file"))
    const wrongKey = bytesToBase64(new Uint8Array(32).fill(9))
    await expect(decryptAttachmentBytes({ ciphertext, key: wrongKey, iv })).rejects.toThrow()
  })
})

describe("attachment ref cache", () => {
  const ref: AttachmentRef = {
    attachmentId: "attach_1",
    key: "a2V5",
    iv: "aXY=",
    filename: "Q3.xlsx",
    mimeType: "application/vnd.ms-excel",
    sizeBytes: 2048,
  }

  it("remembers a ref and reads it back by id", () => {
    rememberAttachmentRef(ref)
    expect(getAttachmentRef("attach_1")).toEqual(ref)
  })

  it("returns null for an unknown id", () => {
    expect(getAttachmentRef("attach_missing")).toBeNull()
  })

  it("clears every ref (lock / account switch must drop key material)", () => {
    rememberAttachmentRef(ref)
    clearAttachmentRefCache()
    expect(getAttachmentRef("attach_1")).toBeNull()
  })
})
