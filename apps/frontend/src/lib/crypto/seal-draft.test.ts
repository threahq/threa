import { describe, it, expect, vi, beforeEach } from "vitest"
import { parseMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import { sealDraftContent, decryptDraftContent } from "./seal-draft"
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
})

describe("seal-draft", () => {
  it("round-trips a draft body through the stream SSK (seal → decrypt)", async () => {
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

    const decrypted = await decryptDraftContent({
      ciphertext: sealed.ciphertext,
      envelope: sealed.envelope,
      e2eVersion: sealed.e2eVersion,
      workspaceId,
      streamId,
      privateKey: unlockedSession.privateKey!,
      recipientKeyId: unlockedSession.keyId!,
    })
    // The body survives the seal → wire → open round-trip (modulo markdown
    // serialization, which is the same transform a sent message goes through).
    expect(decrypted).toEqual(parseMarkdown("hello e2e world"))
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

  it("returns null when the viewer can't resolve the stream key", async () => {
    vi.spyOn(streamKeyCache, "resolveStreamKey").mockResolvedValue(null)

    const decrypted = await decryptDraftContent({
      ciphertext: "AAAA",
      envelope: { v: 2, keyGeneration: 1, iv: "AAAA", aad: "AAAA" },
      e2eVersion: 2,
      workspaceId,
      streamId,
      privateKey: {} as CryptoKey,
      recipientKeyId: "ek_1",
    })
    expect(decrypted).toBeNull()
  })
})
