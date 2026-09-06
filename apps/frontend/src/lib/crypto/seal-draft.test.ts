import { describe, it, expect, vi, beforeEach } from "vitest"
import { parseMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"
import { sealDraftContent } from "./seal-draft"
import { tryDecryptMessagePayload } from "./message-envelope"
import { clearAttachmentRefCache, rememberAttachmentRef } from "./attachment-crypto"
import * as sessionStore from "@/stores/e2e-session-store"
import * as streamKeyCache from "./stream-key-cache"

const workspaceId = "ws_1"
const senderId = "user_1"
const streamId = "stream_e2e"
const draftId = "draft_1"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

// A real 32-byte SSK so the seal/open below run actual AES-256-GCM (only the
// key resolution + session lookup are stubbed — the crypto itself is genuine).
const ssk = crypto.getRandomValues(new Uint8Array(32))

const unlockedSession = {
  status: "unlocked",
  keyId: "ek_1",
  publicKey: null,
  privateKey: {} as CryptoKey,
  deviceTrusted: true,
  error: null,
} as ReturnType<typeof sessionStore.getE2eSessionState>

beforeEach(() => {
  vi.restoreAllMocks()
  clearAttachmentRefCache()
})

describe("seal-draft", () => {
  it("round-trips a draft body through the stream SSK (seal → shared decrypt path)", async () => {
    vi.spyOn(sessionStore, "getE2eSessionState").mockReturnValue(unlockedSession)
    vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue({ keyGeneration: 1, key: ssk })
    vi.spyOn(streamKeyCache, "resolveStreamKey").mockResolvedValue(ssk)

    const sealed = await sealDraftContent({
      workspaceId,
      senderId,
      streamId,
      draftId,
      contentJson: makeDoc("hello e2e world"),
    })
    expect(typeof sealed.ciphertext).toBe("string")
    expect(sealed.ciphertext.length).toBeGreaterThan(0)
    expect(sealed.e2eVersion).toBe(2)
    expect(sealed.contentMarkdown).toBe("hello e2e world")

    // Decrypt via the same primitive the shared decrypt-cache uses on read.
    const opened = await tryDecryptMessagePayload(
      { contentMarkdown: "", ciphertext: sealed.ciphertext, envelope: sealed.envelope, e2eVersion: sealed.e2eVersion },
      {
        privateKey: unlockedSession.privateKey!,
        recipientKeyId: unlockedSession.keyId!,
        workspaceId,
        streamId,
        rootStreamId: streamId,
      }
    )
    expect(opened?.contentJson).toEqual(parseMarkdown("hello e2e world"))
  })

  it("seals the lossless contentJson so a slash command's clientActionId survives the roam (Stage 4e)", async () => {
    vi.spyOn(sessionStore, "getE2eSessionState").mockReturnValue(unlockedSession)
    vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue({ keyGeneration: 1, key: ssk })
    vi.spyOn(streamKeyCache, "resolveStreamKey").mockResolvedValue(ssk)

    // A slashCommand node's clientActionId has no markdown representation — the
    // markdown round-trip drops it (only `/name` survives). Sealing contentJson
    // carries it whole, so a roamed `/aside` still routes locally.
    const commandDoc: JSONContent = {
      type: "doc",
      content: [{ type: "slashCommand", attrs: { name: "aside", clientActionId: "aside" } }],
    }

    const sealed = await sealDraftContent({ workspaceId, senderId, streamId, draftId, contentJson: commandDoc })

    const opened = await tryDecryptMessagePayload(
      { contentMarkdown: "", ciphertext: sealed.ciphertext, envelope: sealed.envelope, e2eVersion: sealed.e2eVersion },
      {
        privateKey: unlockedSession.privateKey!,
        recipientKeyId: unlockedSession.keyId!,
        workspaceId,
        streamId,
        rootStreamId: streamId,
      }
    )
    // The whole node round-trips — not the lossy markdown reconstruction, which
    // would surface `{ name }` with no clientActionId.
    expect(opened?.contentJson).toEqual(commandDoc)
  })

  it("seals attachment refs into the body and recovers them on decrypt (Stage 4d)", async () => {
    vi.spyOn(sessionStore, "getE2eSessionState").mockReturnValue(unlockedSession)
    vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue({ keyGeneration: 1, key: ssk })
    vi.spyOn(streamKeyCache, "resolveStreamKey").mockResolvedValue(ssk)

    // The per-file key/iv were minted at upload and live in the in-memory ref
    // cache; the seal pulls them in by id (the same path messages use).
    rememberAttachmentRef({
      attachmentId: "att_1",
      key: "a2V5",
      iv: "aXY=",
      filename: "secret.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
    })

    const sealed = await sealDraftContent({
      workspaceId,
      senderId,
      streamId,
      draftId,
      contentJson: makeDoc("body with a file"),
      attachmentIds: ["att_1"],
    })
    expect(sealed.attachmentRefs).toHaveLength(1)

    // The refs ride inside the SSK ciphertext — never on the wire — and come back
    // on decrypt so the receiving device can render + fetch + re-seal the file.
    const opened = await tryDecryptMessagePayload(
      { contentMarkdown: "", ciphertext: sealed.ciphertext, envelope: sealed.envelope, e2eVersion: sealed.e2eVersion },
      {
        privateKey: unlockedSession.privateKey!,
        recipientKeyId: unlockedSession.keyId!,
        workspaceId,
        streamId,
        rootStreamId: streamId,
      }
    )
    expect(opened?.contentJson).toEqual(parseMarkdown("body with a file"))
    // The full ref must round-trip — display metadata AND the per-file crypto
    // material (key/iv), which is what makes a roamed attachment viewable/sendable.
    expect(opened?.attachmentRefs).toEqual([
      {
        attachmentId: "att_1",
        key: "a2V5",
        iv: "aXY=",
        filename: "secret.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
      },
    ])
  })

  it("throws when the session is locked (the caller keeps content in the composer)", async () => {
    vi.spyOn(sessionStore, "getE2eSessionState").mockReturnValue({
      ...unlockedSession,
      status: "locked",
      privateKey: null,
      keyId: null,
    } as ReturnType<typeof sessionStore.getE2eSessionState>)

    await expect(
      sealDraftContent({ workspaceId, senderId, streamId, draftId, contentJson: makeDoc("secret") })
    ).rejects.toThrow()
  })

  it("the decrypt path returns null when the viewer can't resolve the stream key", async () => {
    vi.spyOn(streamKeyCache, "resolveStreamKey").mockResolvedValue(null)

    const opened = await tryDecryptMessagePayload(
      {
        contentMarkdown: "",
        ciphertext: "AAAA",
        envelope: { v: 2, keyGeneration: 1, iv: "AAAA", aad: "AAAA" },
        e2eVersion: 2,
      },
      {
        privateKey: {} as CryptoKey,
        recipientKeyId: "ek_1",
        workspaceId,
        streamId,
        rootStreamId: streamId,
      }
    )
    expect(opened).toBeNull()
  })
})
