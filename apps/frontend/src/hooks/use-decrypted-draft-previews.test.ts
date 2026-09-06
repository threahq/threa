import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { JSONContent } from "@threahq/types"
import type { CachedDraft } from "@/db"
import { useDecryptedDraftPreviews } from "./use-decrypted-draft-previews"
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

function plaintextDraft(id: string, text: string): CachedDraft {
  return {
    id,
    workspaceId,
    scope: `stream:${rootStreamId}`,
    contentJson: makeDoc(text),
    attachments: [],
    clientUpdatedAt: 1,
  }
}

function sealedDraft(id: string, ciphertext = "ct_sealed"): CachedDraft {
  return {
    id,
    workspaceId,
    scope: `stream:${rootStreamId}`,
    contentJson: EMPTY_DOC,
    attachments: [],
    ciphertext,
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

describe("useDecryptedDraftPreviews", () => {
  it("returns plaintext previews straight from contentJson", () => {
    const draft = plaintextDraft("draft_p", "hello plain")
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, [{ draft, rootStreamId: undefined }]))
    expect(result.current.get("draft_p")).toEqual({
      text: "hello plain",
      markdown: "hello plain",
      attachmentCount: 0,
      status: "ready",
    })
  })

  it("returns the decrypted body for a sealed draft already in the shared cache", () => {
    const draft = sealedDraft("draft_e")
    seedDecryption("draft_e", { contentMarkdown: "secret body", contentJson: makeDoc("secret body") })
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, [{ draft, rootStreamId }]))
    expect(result.current.get("draft_e")).toEqual({
      text: "secret body",
      markdown: "secret body",
      attachmentCount: 0,
      status: "ready",
    })
  })

  it("reports a sealed draft as locked while the session is locked (no decrypt attempted)", () => {
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(locked)
    const draft = sealedDraft("draft_e")
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, [{ draft, rootStreamId }]))
    expect(result.current.get("draft_e")).toEqual({ text: "", markdown: "", attachmentCount: 0, status: "locked" })
  })

  it("reports decrypting for an unlocked sealed draft whose body hasn't landed yet", () => {
    // Decrypt is in flight (never resolves here) → the preview is `decrypting`.
    vi.spyOn(messageEnvelope, "tryDecryptMessagePayload").mockReturnValue(new Promise(() => {}))
    const draft = sealedDraft("draft_e")
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, [{ draft, rootStreamId }]))
    expect(result.current.get("draft_e")).toEqual({ text: "", markdown: "", attachmentCount: 0, status: "decrypting" })
  })

  it("reports failed when the decrypt returns null", async () => {
    vi.spyOn(messageEnvelope, "tryDecryptMessagePayload").mockResolvedValue(null)
    await requestDecryption(
      "draft_e",
      { contentMarkdown: "", ciphertext: "ct_sealed", envelope: { v: 2 } },
      { privateKey: {} as CryptoKey, recipientKeyId: "ek_1", workspaceId, streamId: rootStreamId, rootStreamId }
    )
    const draft = sealedDraft("draft_e")
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, [{ draft, rootStreamId }]))
    await waitFor(() =>
      expect(result.current.get("draft_e")).toEqual({ text: "", markdown: "", attachmentCount: 0, status: "failed" })
    )
  })

  it("resolves each id independently across a mixed batch in one render", async () => {
    // The whole reason this hook exists (vs. the per-id one in a loop) is to build
    // a correct per-id map across MANY drafts at once. One unlocked session, four
    // drafts, four different outcomes — distinct ciphertexts let one decrypt fail
    // while another hangs in the SAME render, so a bug that smeared inputs[0]'s
    // state across the map (or only handled the first row) would surface here.
    vi.spyOn(messageEnvelope, "tryDecryptMessagePayload").mockImplementation((payload) =>
      payload.ciphertext === "ct_fail" ? Promise.resolve(null) : new Promise<null>(() => {})
    )
    seedDecryption("draft_seeded", { contentMarkdown: "seeded body", contentJson: makeDoc("seeded body") })

    const inputs = [
      { draft: plaintextDraft("draft_plain", "plain body"), rootStreamId: undefined },
      { draft: sealedDraft("draft_seeded"), rootStreamId },
      { draft: sealedDraft("draft_fail", "ct_fail"), rootStreamId },
      { draft: sealedDraft("draft_hang", "ct_hang"), rootStreamId },
    ]
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, inputs))

    await waitFor(() =>
      expect(result.current.get("draft_fail")).toEqual({ text: "", markdown: "", attachmentCount: 0, status: "failed" })
    )
    expect(result.current.get("draft_plain")).toEqual({
      text: "plain body",
      markdown: "plain body",
      attachmentCount: 0,
      status: "ready",
    })
    expect(result.current.get("draft_seeded")).toEqual({
      text: "seeded body",
      markdown: "seeded body",
      attachmentCount: 0,
      status: "ready",
    })
    expect(result.current.get("draft_hang")).toEqual({
      text: "",
      markdown: "",
      attachmentCount: 0,
      status: "decrypting",
    })
    expect(result.current.size).toBe(4)
  })
})
