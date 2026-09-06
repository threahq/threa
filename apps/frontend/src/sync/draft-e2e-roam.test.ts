import { describe, it, expect, vi, beforeEach } from "vitest"
import { parseMarkdown } from "@threahq/prosemirror"
import type { Draft, JSONContent } from "@threahq/types"
import { db } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import { sealDraftContent } from "@/lib/crypto/seal-draft"
import { tryDecryptMessagePayload } from "@/lib/crypto/message-envelope"
import { clearAttachmentRefCache, getAttachmentRef, rememberAttachmentRef } from "@/lib/crypto/attachment-crypto"
import { clearDecryptCache } from "@/lib/crypto/decrypt-cache"
import { requestDraftDecryption } from "@/lib/drafts/decryption"
import { applyDraftUpserted } from "./draft-sync"
import * as sessionStore from "@/stores/e2e-session-store"
import * as streamKeyCache from "@/lib/crypto/stream-key-cache"

/**
 * End-to-end roam proof for E2E drafts: seal on device A → the wire shape →
 * `applyDraftUpserted` on a fresh device B → decrypt on read. Real AES-256-GCM
 * runs (only the SSK resolution + session lookup are stubbed). This is the loop
 * that was never exercised — the unit tests passed while the real roam was
 * broken.
 */

const workspaceId = "ws_1"
const userId = "user_1"
const streamId = "stream_e2e" // the encrypted root whose SSK seals the body
const scope = `stream:${streamId}`
const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] }

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

const ssk = crypto.getRandomValues(new Uint8Array(32))
const session = {
  status: "unlocked",
  keyId: "ek_1",
  publicKey: null,
  privateKey: {} as CryptoKey,
  deviceTrusted: true,
  error: null,
} as ReturnType<typeof sessionStore.getE2eSessionState>

beforeEach(async () => {
  vi.restoreAllMocks()
  resetDraftStoreCache()
  clearDecryptCache()
  clearAttachmentRefCache()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.pendingOperations.clear()
  vi.spyOn(sessionStore, "getE2eSessionState").mockReturnValue(session)
  vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue({ keyGeneration: 1, key: ssk })
  vi.spyOn(streamKeyCache, "resolveStreamKey").mockResolvedValue(ssk)
})

describe("E2E draft roam (seal → wire → apply → decrypt)", () => {
  it("a sealed draft survives the wire shape and decrypts on the receiving device", async () => {
    // Device A seals the body.
    const sealed = await sealDraftContent({
      workspaceId,
      senderId: userId,
      streamId,
      draftId: "draft_x",
      contentJson: makeDoc("roaming secret"),
    })

    // The row the backend stores and fans out: ciphertext sibling, no plaintext.
    const wire: Draft = {
      id: "draft_x",
      workspaceId,
      userId,
      scope,
      rootStreamId: streamId,
      contentJson: null,
      contentMarkdown: null,
      attachmentIds: [],
      command: null,
      contextRefs: null,
      ciphertext: sealed.ciphertext,
      envelope: sealed.envelope,
      e2eVersion: sealed.e2eVersion,
      version: 1,
      clientUpdatedAt: new Date().toISOString(),
      stashedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // Device B applies the inbound draft (socket / bootstrap).
    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wire }, workspaceId)

    // At rest on B: ciphertext only, never the plaintext body (E2EE-4).
    const stored = await db.drafts.get("draft_x")
    expect(stored?.ciphertext).toBe(sealed.ciphertext)
    expect(stored?.e2eVersion).toBe(sealed.e2eVersion)
    expect(stored?.contentJson).toEqual(EMPTY_DOC)

    // B decrypts on read — the same primitive the shared decrypt cache runs.
    const opened = await tryDecryptMessagePayload(
      {
        contentMarkdown: "",
        ciphertext: stored!.ciphertext!,
        envelope: stored!.envelope,
        e2eVersion: stored!.e2eVersion,
      },
      {
        privateKey: session.privateKey!,
        recipientKeyId: session.keyId!,
        workspaceId,
        streamId,
        rootStreamId: streamId,
      }
    )
    expect(opened?.contentJson).toEqual(parseMarkdown("roaming secret"))
  })

  it("a sealed draft's attachments roam and their keys re-register on the receiving device (Stage 4d)", async () => {
    // Device A: the per-file key/iv were minted at upload and held in memory.
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
      senderId: userId,
      streamId,
      draftId: "draft_att",
      contentJson: makeDoc("see attached"),
      attachmentIds: ["att_1"],
    })

    const wire: Draft = {
      id: "draft_att",
      workspaceId,
      userId,
      scope,
      stashedAt: null,
      rootStreamId: streamId,
      contentJson: null,
      contentMarkdown: null,
      // No plaintext attachment linkage on the wire — it rides sealed in the body.
      attachmentIds: [],
      command: null,
      contextRefs: null,
      ciphertext: sealed.ciphertext,
      envelope: sealed.envelope,
      e2eVersion: sealed.e2eVersion,
      version: 1,
      clientUpdatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // Device B: fresh — the in-memory ref cache is empty, so the file can't be
    // fetched or re-sealed until the draft decrypts and re-registers its key.
    clearAttachmentRefCache()
    expect(getAttachmentRef("att_1")).toBeNull()

    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wire }, workspaceId)
    const stored = await db.drafts.get("draft_att")
    // At rest the row carries no plaintext attachment metadata (E2EE-4).
    expect(stored?.attachments).toEqual([])

    // The composer's decrypt-on-read recovers the refs and re-registers them so a
    // later send on THIS device can re-seal the attachment by id.
    requestDraftDecryption(
      stored!,
      { privateKey: session.privateKey!, recipientKeyId: session.keyId! },
      workspaceId,
      streamId
    )
    await vi.waitFor(() => expect(getAttachmentRef("att_1")).not.toBeNull())
    // The re-registered ref must carry the crypto material (key/iv), not just
    // display metadata — otherwise B couldn't view or re-seal the attachment.
    expect(getAttachmentRef("att_1")).toEqual({
      attachmentId: "att_1",
      key: "a2V5",
      iv: "aXY=",
      filename: "secret.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
    })
  })
})
