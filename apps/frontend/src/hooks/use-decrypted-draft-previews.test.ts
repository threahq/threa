import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import type { JSONContent } from "@threa/types"
import type { CachedDraft } from "@/db"
import { useDecryptedDraftPreviews } from "./use-decrypted-draft-previews"
import { seedDecryption, clearDecryptCache } from "@/lib/crypto/decrypt-cache"
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

function sealedDraft(id: string): CachedDraft {
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

describe("useDecryptedDraftPreviews", () => {
  it("returns plaintext previews straight from contentJson", () => {
    const draft = plaintextDraft("draft_p", "hello plain")
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, [{ draft, rootStreamId: undefined }]))
    expect(result.current.get("draft_p")).toEqual({ text: "hello plain", status: "ready" })
  })

  it("returns the decrypted body for a sealed draft already in the shared cache", () => {
    const draft = sealedDraft("draft_e")
    seedDecryption("draft_e", { contentMarkdown: "secret body", contentJson: makeDoc("secret body") })
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, [{ draft, rootStreamId }]))
    expect(result.current.get("draft_e")).toEqual({ text: "secret body", status: "ready" })
  })

  it("reports a sealed draft as locked while the session is locked (no decrypt attempted)", () => {
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(locked)
    const draft = sealedDraft("draft_e")
    const { result } = renderHook(() => useDecryptedDraftPreviews(workspaceId, [{ draft, rootStreamId }]))
    expect(result.current.get("draft_e")).toEqual({ text: "", status: "locked" })
  })
})
