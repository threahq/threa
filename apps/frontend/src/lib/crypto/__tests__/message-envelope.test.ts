import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildWrapAad,
  bytesToBase64,
  encryptPayload,
  generateStreamKey,
  serializeSealedPayload,
  wrapStreamKey,
  type StreamEnvelope,
} from "@threa/crypto"
import { generateUIK } from "../keys"
import {
  parseSealedPayload,
  sealStreamMessage,
  sealStreamName,
  tryDecryptMessagePayload,
  tryOpenStreamName,
} from "../message-envelope"
import { clearStreamKeyCache } from "../stream-key-cache"
import type { AttachmentRef } from "../attachment-crypto"
import { e2eKeyWrapsApi } from "@/api/e2e-key-wraps"

const WS = "ws_1"
const STREAM = "stream_01"
const SENDER = "usr_alice"
const MSG = "msg_01"
const KEY_ID = "e2ek_alice"

beforeEach(() => {
  clearStreamKeyCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Stub the wraps endpoint with a single owner wrap for generation 0. */
async function stubOwnerWrap(ssk: Uint8Array, publicKey: Uint8Array, recipientKeyId = KEY_ID): Promise<void> {
  const wrap = await wrapStreamKey({
    key: ssk,
    recipientPublicKey: publicKey,
    aad: buildWrapAad({ streamId: STREAM, keyGeneration: 0, recipientKeyId }),
  })
  vi.spyOn(e2eKeyWrapsApi, "get").mockResolvedValue({
    currentKeyGeneration: 0,
    ownerUserId: "user_owner",
    liveActorRecipients: [],
    wraps: [
      {
        keyGeneration: 0,
        recipientKeyId,
        recipientKind: "user",
        wrapEnc: bytesToBase64(wrap.enc),
        wrapCt: bytesToBase64(wrap.ct),
      },
    ],
  })
}

describe("sealStreamMessage + tryDecryptMessagePayload (v2 SSK loopback)", () => {
  it("round-trips markdown sealed under the SSK and opened via the resolved wrap", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubOwnerWrap(ssk, uik.publicKey)

    const sealed = await sealStreamMessage({
      contentMarkdown: "hello **world**",
      streamId: STREAM,
      messageId: MSG,
      senderId: SENDER,
      ssk,
      keyGeneration: 0,
    })
    expect(sealed.e2eVersion).toBe(2)
    expect(sealed.envelope.keyGeneration).toBe(0)

    const result = await tryDecryptMessagePayload(
      { contentMarkdown: "​", ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    expect(result?.contentMarkdown).toBe("hello **world**")
    expect(result?.contentJson).toBeDefined()
  })

  it("returns null when the viewer holds no wrap for the message generation", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    // Wrap is addressed to a different key id than the viewer presents.
    await stubOwnerWrap(ssk, uik.publicKey, "e2ek_someone_else")

    const sealed = await sealStreamMessage({
      contentMarkdown: "secret",
      streamId: STREAM,
      messageId: MSG,
      senderId: SENDER,
      ssk,
      keyGeneration: 0,
    })

    const result = await tryDecryptMessagePayload(
      { contentMarkdown: "​", ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    expect(result).toBeNull()
  })

  it("seals attachmentRefs into the payload and still opens to the plain markdown", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubOwnerWrap(ssk, uik.publicKey)

    const sealed = await sealStreamMessage({
      contentMarkdown: "see attached",
      streamId: STREAM,
      messageId: MSG,
      senderId: SENDER,
      ssk,
      keyGeneration: 0,
      attachmentRefs: [
        {
          attachmentId: "attach_1",
          key: "a2V5",
          iv: "aXY=",
          filename: "Q3.xlsx",
          mimeType: "application/vnd.ms-excel",
          sizeBytes: 2048,
        },
      ],
    })

    const result = await tryDecryptMessagePayload(
      { contentMarkdown: "​", ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    // The body is clean markdown and the refs are surfaced so the viewer can
    // decrypt the file. One object assertion over the decrypted shape; the
    // wrapper-never-leaks check stays separate.
    expect(result).toMatchObject({
      contentMarkdown: "see attached",
      attachmentRefs: [
        { attachmentId: "attach_1", filename: "Q3.xlsx", mimeType: "application/vnd.ms-excel", sizeBytes: 2048 },
      ],
    })
    expect(result?.contentMarkdown).not.toContain("attach_1")
  })

  it("returns null when the ciphertext is tampered (AEAD auth fails)", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubOwnerWrap(ssk, uik.publicKey)

    const sealed = await sealStreamMessage({
      contentMarkdown: "hello",
      streamId: STREAM,
      messageId: MSG,
      senderId: SENDER,
      ssk,
      keyGeneration: 0,
    })
    const tampered = `${sealed.ciphertext.slice(0, -4)}AAAA`

    const result = await tryDecryptMessagePayload(
      { contentMarkdown: "​", ciphertext: tampered, envelope: sealed.envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    expect(result).toBeNull()
  })
})

describe("tryDecryptMessagePayload — thread inherits the root's SSK (resolve against root)", () => {
  const THREAD = "stream_thread_01"

  /**
   * Stub the wraps endpoint so the SSK is wrapped under the ROOT's id (as the
   * owner provisioned it) and the THREAD has no wraps of its own — exactly the
   * post-#793-fix layout. The wrap AAD is bound to the root, so it can only be
   * unwrapped when resolution targets the root.
   */
  async function stubRootOnlyWrap(ssk: Uint8Array, publicKey: Uint8Array): Promise<void> {
    const wrap = await wrapStreamKey({
      key: ssk,
      recipientPublicKey: publicKey,
      aad: buildWrapAad({ streamId: STREAM, keyGeneration: 0, recipientKeyId: KEY_ID }),
    })
    vi.spyOn(e2eKeyWrapsApi, "get").mockImplementation(async (_ws: string, sid: string) => ({
      currentKeyGeneration: 0,
      ownerUserId: "user_owner",
      liveActorRecipients: [],
      wraps:
        sid === STREAM
          ? [
              {
                keyGeneration: 0,
                recipientKeyId: KEY_ID,
                recipientKind: "user" as const,
                wrapEnc: bytesToBase64(wrap.enc),
                wrapCt: bytesToBase64(wrap.ct),
              },
            ]
          : [],
    }))
  }

  it("decrypts a thread message when rootStreamId points at the key-bearing root", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubRootOnlyWrap(ssk, uik.publicKey)

    const sealed = await sealStreamMessage({
      contentMarkdown: "sealed in a thread",
      streamId: STREAM,
      messageId: MSG,
      senderId: SENDER,
      ssk,
      keyGeneration: 0,
    })

    const result = await tryDecryptMessagePayload(
      { contentMarkdown: "​", ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: THREAD, rootStreamId: STREAM }
    )
    expect(result?.contentMarkdown).toBe("sealed in a thread")
  })

  it("returns null for a thread message when resolved against the thread id (the #793 bug)", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubRootOnlyWrap(ssk, uik.publicKey)

    const sealed = await sealStreamMessage({
      contentMarkdown: "sealed in a thread",
      streamId: STREAM,
      messageId: MSG,
      senderId: SENDER,
      ssk,
      keyGeneration: 0,
    })

    // No rootStreamId → resolution falls back to the thread id, which has no
    // wraps (and a copied wrap's AAD wouldn't match anyway) → undecryptable.
    const result = await tryDecryptMessagePayload(
      { contentMarkdown: "​", ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: THREAD }
    )
    expect(result).toBeNull()
  })
})

describe("sealStreamName + tryOpenStreamName (sealed stream name loopback)", () => {
  it("round-trips a name sealed under the SSK and opened via the resolved wrap", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubOwnerWrap(ssk, uik.publicKey)

    const sealed = await sealStreamName({ name: "Therapy notes", streamId: STREAM, ssk, keyGeneration: 0 })
    expect(sealed.envelope.keyGeneration).toBe(0)

    const name = await tryOpenStreamName(
      { ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    expect(name).toBe("Therapy notes")
  })

  it("returns null when there is no sealed name", async () => {
    const uik = await generateUIK()
    const name = await tryOpenStreamName(
      { ciphertext: null, envelope: null },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    expect(name).toBeNull()
  })

  it("returns null when the viewer holds no wrap for the name's generation", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubOwnerWrap(ssk, uik.publicKey, "e2ek_someone_else")

    const sealed = await sealStreamName({ name: "Secret name", streamId: STREAM, ssk, keyGeneration: 0 })

    const name = await tryOpenStreamName(
      { ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    expect(name).toBeNull()
  })
})

describe("tryDecryptMessagePayload (v1 fan-out read-compat)", () => {
  it("still unwraps a legacy per-message recipient envelope", async () => {
    const uik = await generateUIK()
    const { envelope } = await encryptPayload({
      payload: "legacy message",
      recipients: [{ recipientKeyId: KEY_ID, publicKey: uik.publicKey }],
      aad: new TextEncoder().encode("aad"),
    })

    const result = await tryDecryptMessagePayload(
      { contentMarkdown: "​", ciphertext: envelope.ciphertext, envelope },
      { privateKey: uik.privateKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    expect(result?.contentMarkdown).toBe("legacy message")
  })

  it("returns null for an unknown envelope version", async () => {
    const bogus = { v: 99, keyGeneration: 0, iv: "AAAA", aad: "AAAA" } satisfies Record<string, unknown> &
      Partial<StreamEnvelope>
    const result = await tryDecryptMessagePayload(
      { contentMarkdown: "​", ciphertext: "AAAA", envelope: bogus },
      { privateKey: {} as CryptoKey, recipientKeyId: KEY_ID, workspaceId: WS, streamId: STREAM }
    )
    expect(result).toBeNull()
  })
})

describe("parseSealedPayload", () => {
  const refs: AttachmentRef[] = [
    { attachmentId: "attach_1", key: "a2V5", iv: "aXY=", filename: "Q3.xlsx", mimeType: "x", sizeBytes: 1 },
  ]

  it("returns a bare markdown string unchanged (the no-attachment shape)", () => {
    expect(parseSealedPayload("hello **world**")).toEqual({
      contentMarkdown: "hello **world**",
      attachmentRefs: [],
      sources: [],
    })
  })

  it("treats markdown that merely starts with `{` as markdown, not a wrapper", () => {
    expect(parseSealedPayload("{not json at all")).toEqual({
      contentMarkdown: "{not json at all",
      attachmentRefs: [],
      sources: [],
    })
    const jsonButNotOurs = JSON.stringify({ foo: "bar" })
    expect(parseSealedPayload(jsonButNotOurs)).toEqual({
      contentMarkdown: jsonButNotOurs,
      attachmentRefs: [],
      sources: [],
    })
  })

  it("extracts contentMarkdown and refs from the versioned wrapper", () => {
    const wrapper = JSON.stringify({ __e2ePayload: 1, contentMarkdown: "see attached", attachmentRefs: refs })
    expect(parseSealedPayload(wrapper)).toEqual({ contentMarkdown: "see attached", attachmentRefs: refs, sources: [] })
  })

  it("falls back to no refs when a wrapper's attachmentRefs is not an array", () => {
    const malformed = JSON.stringify({ __e2ePayload: 1, contentMarkdown: "body", attachmentRefs: "oops" })
    expect(parseSealedPayload(malformed)).toEqual({ contentMarkdown: "body", attachmentRefs: [], sources: [] })
  })

  it("extracts citation sources sealed into the wrapper (agent replies, E2EE-9)", () => {
    const sources = [{ type: "web", title: "Tide Atlas", url: "https://tides.example/atlas" }]
    const wrapper = serializeSealedPayload("Tides come from the moon.", undefined, sources)
    expect(parseSealedPayload(wrapper)).toEqual({
      contentMarkdown: "Tides come from the moon.",
      attachmentRefs: [],
      sources,
    })
  })

  it("drops malformed source elements but keeps valid ones", () => {
    const wrapper = JSON.stringify({
      __e2ePayload: 1,
      contentMarkdown: "body",
      attachmentRefs: [],
      sources: [{ title: "Valid", url: "https://example.com" }, { title: 42, url: "https://bad.example" }, "junk"],
    })
    expect(parseSealedPayload(wrapper)).toEqual({
      contentMarkdown: "body",
      attachmentRefs: [],
      sources: [{ title: "Valid", url: "https://example.com" }],
    })
  })

  it("seals bare markdown (no wrapper) when there are no refs and no sources", () => {
    expect(serializeSealedPayload("plain body")).toBe("plain body")
    expect(serializeSealedPayload("plain body", [], [])).toBe("plain body")
  })
})
