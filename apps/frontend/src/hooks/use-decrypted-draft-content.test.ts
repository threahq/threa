import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { JSONContent } from "@threa/types"
import type { CachedDraft } from "@/db"
import { useDecryptedDraftContent } from "./use-decrypted-draft-content"
import { requestDecryption, seedDecryption, clearDecryptCache } from "@/lib/crypto/decrypt-cache"
import * as messageEnvelope from "@/lib/crypto/message-envelope"
import * as currentUserHook from "./use-current-workspace-user-id"
import * as e2eSessionStore from "@/stores/e2e-session-store"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})
const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

const workspaceId = "ws_1"
const rootStreamId = "stream_e2e"

const unlocked = {
  status: "unlocked",
  keyId: "ek_1",
  publicKey: null,
  privateKey: {} as CryptoKey,
  deviceTrusted: true,
  error: null,
} as ReturnType<typeof e2eSessionStore.useE2eSession>

const locked = {
  status: "locked",
  keyId: null,
  publicKey: null,
  privateKey: null,
  deviceTrusted: false,
  error: null,
} as ReturnType<typeof e2eSessionStore.useE2eSession>

function plaintextDraft(text: string): CachedDraft {
  return {
    id: "draft_p",
    workspaceId,
    scope: `stream:${rootStreamId}`,
    contentJson: makeDoc(text),
    attachments: [],
    clientUpdatedAt: 1,
  }
}

function sealedDraft(id = "draft_e"): CachedDraft {
  return {
    id,
    workspaceId,
    scope: `stream:${rootStreamId}`,
    contentJson: EMPTY_DOC,
    attachments: [],
    ciphertext: "ct_sealed",
    envelope: { v: 2 },
    e2eVersion: 2,
    clientUpdatedAt: 1,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  clearDecryptCache()
  vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue("user_1")
  vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(unlocked)
})

describe("useDecryptedDraftContent", () => {
  it("reports none when there is no draft", () => {
    const { result } = renderHook(() => useDecryptedDraftContent(workspaceId, undefined, rootStreamId))
    expect(result.current.status).toBe("none")
  })

  it("reports plaintext (with the body) for a non-E2E draft", () => {
    const { result } = renderHook(() => useDecryptedDraftContent(workspaceId, plaintextDraft("hi"), undefined))
    expect(result.current).toEqual({ status: "plaintext", contentJson: makeDoc("hi"), attachments: [] })
  })

  it("reports locked for a sealed draft while the session is locked", () => {
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(locked)
    const { result } = renderHook(() => useDecryptedDraftContent(workspaceId, sealedDraft(), rootStreamId))
    expect(result.current.status).toBe("locked")
  })

  it("reports decrypted (with the body) when the shared cache already holds the plaintext", () => {
    seedDecryption("draft_e", { contentMarkdown: "secret", contentJson: makeDoc("secret") })
    const { result } = renderHook(() => useDecryptedDraftContent(workspaceId, sealedDraft(), rootStreamId))
    expect(result.current).toEqual({ status: "decrypted", contentJson: makeDoc("secret"), attachments: [] })
  })

  it("surfaces attachments recovered from the decrypted refs (Stage 4d)", () => {
    seedDecryption("draft_e", {
      contentMarkdown: "secret",
      contentJson: makeDoc("secret"),
      attachmentRefs: [
        { attachmentId: "att_1", key: "k", iv: "i", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 42 },
      ],
      sources: [],
    })
    const { result } = renderHook(() => useDecryptedDraftContent(workspaceId, sealedDraft(), rootStreamId))
    expect(result.current.attachments).toEqual([
      { id: "att_1", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 42 },
    ])
  })

  it("reports pending while unlocked but the encrypted root isn't known yet (no decrypt fired)", () => {
    const { result } = renderHook(() => useDecryptedDraftContent(workspaceId, sealedDraft(), undefined))
    expect(result.current.status).toBe("pending")
  })

  it("reports failed when the decrypt returns null (wrong recipient / garbled)", async () => {
    vi.spyOn(messageEnvelope, "tryDecryptMessagePayload").mockResolvedValue(null)
    await requestDecryption(
      "draft_e",
      { contentMarkdown: "", ciphertext: "ct_sealed", envelope: { v: 2 } },
      { privateKey: {} as CryptoKey, recipientKeyId: "ek_1", workspaceId, streamId: rootStreamId, rootStreamId }
    )
    const { result } = renderHook(() => useDecryptedDraftContent(workspaceId, sealedDraft(), rootStreamId))
    await waitFor(() => expect(result.current.status).toBe("failed"))
  })
})
