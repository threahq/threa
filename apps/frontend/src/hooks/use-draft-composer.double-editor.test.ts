import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, cleanup, waitFor } from "@testing-library/react"
import { useDraftComposer } from "./use-draft-composer"
import * as useAttachmentsModule from "./use-attachments"
import * as currentUserHook from "./use-current-workspace-user-id"
import * as e2eSessionStore from "@/stores/e2e-session-store"
import { upsertLoadedDraft, clearLoadedDraft } from "./use-draft-message"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import { resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"
import { resetApplyWindow } from "@/stores/apply-window"
import { readStagedDraft } from "@/lib/drafts/draft-staging"
import { db } from "@/db"
import type { JSONContent } from "@threa/types"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

const workspaceId = "ws_double"
// The board card and the conversation panel host the SAME conversation's reply
// composer under one scope (`boardReplyDraftKey`), so both are live editors on
// one draft row.
const draftKey = "board:reply:conv_1"

const LOCKED_SESSION = {
  status: "locked",
  keyId: null,
  publicKey: null,
  privateKey: null,
  deviceTrusted: false,
  error: null,
} as ReturnType<typeof e2eSessionStore.useE2eSession>

const UPLOADED_ATTACHMENT = {
  id: "att_1",
  status: "uploaded",
  filename: "shot.png",
  mimeType: "image/png",
  sizeBytes: 1024,
}

function stubAttachments(snapshot: unknown[] = []) {
  vi.spyOn(useAttachmentsModule, "useAttachments").mockReturnValue({
    pendingAttachments: [],
    getPendingAttachmentsSnapshot: () => snapshot,
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(),
    uploadFile: vi.fn(),
    removeAttachment: vi.fn(),
    cancelUpload: vi.fn(),
    uploadedIds: [],
    isUploading: false,
    isReserving: false,
    hasFailed: false,
    clear: vi.fn(),
    restore: vi.fn(),
    imageCount: 0,
  } as unknown as ReturnType<typeof useAttachmentsModule.useAttachments>)
}

function mountComposer() {
  return renderHook(() => useDraftComposer({ workspaceId, draftKey, scopeId: draftKey }))
}

/** Every place the scope's text can still live after the other editor sends. */
async function recoverableBodies(): Promise<string[]> {
  const rows = await db.drafts.where("scope").equals(draftKey).toArray()
  const bodies = rows.map((row) => JSON.stringify(row.contentJson))
  const staged = readStagedDraft(workspaceId, draftKey)
  if (staged) bodies.push(JSON.stringify(staged.contentJson))
  return bodies
}

describe("two composers on one draft scope (board card + conversation panel)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    resetApplyWindow()
    resetDraftStoreCache()
    resetDraftResolutionGuard()
    localStorage.clear()
    await db.drafts.clear()
    await db.composerLoaded.clear()
    await db.pendingOperations.clear()
    vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue(null)
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
    stubAttachments()
  })

  afterEach(() => {
    // Unmount every composer: the mounted-per-scope registry is module-level, so
    // a leaked mount would make the next case look like a shared scope.
    cleanup()
    vi.restoreAllMocks()
  })

  it("keeps the second editor's unsent text recoverable after the first editor sends", async () => {
    await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("A"), attachments: [] })
    await act(async () => {
      await seedDraftCacheFromIdb(workspaceId)
    })

    const panel = mountComposer()
    const card = mountComposer()
    expect(panel.result.current.content).toEqual(makeDoc("A"))
    expect(card.result.current.content).toEqual(makeDoc("A"))

    // The user types in the card; its debounced save lands on the shared row.
    await act(async () => {
      card.result.current.handleContentChange(makeDoc("B"))
    })
    await act(async () => {
      await card.result.current.flushDraft()
    })

    // The panel never re-read the same-id body change — it still holds "A" and
    // sends that, resolving (removing) the shared row.
    expect(panel.result.current.content).toEqual(makeDoc("A"))
    await act(async () => {
      await panel.result.current.resolveDraft()
    })

    // The card still shows "B" on screen, but it must also survive its unmount.
    expect(card.result.current.content).toEqual(makeDoc("B"))
    card.unmount()

    // The rescue is fire-and-forget (and serialized behind the write chain), so
    // poll for it rather than reading a fixed instant after unmount.
    await vi.waitFor(async () => {
      const bodies = await recoverableBodies()
      expect(bodies.some((body) => body.includes('"B"'))).toBe(true)
    })
  })

  it("does not resurrect the sender's own just-sent body", async () => {
    await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("A"), attachments: [] })
    await act(async () => {
      await seedDraftCacheFromIdb(workspaceId)
    })

    // The sender must be CO-MOUNTED, or the rescue exits on the composer-count
    // gate and this asserts nothing: what is under test is the content gate, i.e.
    // that every send path empties its editor before resolving. The idle sibling
    // never engages, so only the sender can reach the rescue.
    const idleSibling = mountComposer()
    const sender = mountComposer()
    await act(async () => {
      sender.result.current.handleContentChange(makeDoc("A2"))
    })
    // The send path empties the editor, then resolves the row.
    await act(async () => {
      sender.result.current.setContent({ type: "doc", content: [{ type: "paragraph" }] })
    })
    await act(async () => {
      await sender.result.current.resolveDraft()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    expect(await db.drafts.where("scope").equals(draftKey).count()).toBe(0)
    expect(sender.result.current.content).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
    // The idle sibling never engaged, so it takes the blank path: the send is
    // visible there rather than leaving a stale body on screen.
    expect(idleSibling.result.current.content).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
  })

  it("creates nothing when a LONE composer's pointer is torn down while engaged", async () => {
    await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("A"), attachments: [] })
    await act(async () => {
      await seedDraftCacheFromIdb(workspaceId)
    })

    const composer = mountComposer()
    await act(async () => {
      composer.result.current.handleContentChange(makeDoc("B"))
    })

    // A deliberate teardown of the scope's pointer (discard / relocate / purge)
    // with no second composer alive: nothing may be re-created under this scope.
    await act(async () => {
      await clearLoadedDraft(workspaceId, draftKey)
    })
    await act(async () => {
      composer.rerender()
    })
    // Let any write the effect started reach IDB before asserting none did.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(await db.drafts.where("scope").equals(draftKey).count()).toBe(0)
    // Pre-existing flicker guard: an engaged editor keeps its text either way.
    expect(composer.result.current.content).toEqual(makeDoc("B"))
  })

  it("leaves a draft deleted elsewhere deleted, even with two composers mounted", async () => {
    await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("A"), attachments: [] })
    await act(async () => {
      await seedDraftCacheFromIdb(workspaceId)
    })

    const panel = mountComposer()
    const card = mountComposer()
    await act(async () => {
      card.result.current.handleContentChange(makeDoc("B"))
    })

    // The row goes away without this device resolving it on send — a
    // `draft:deleted` from another device, or a discard. Two composers are alive,
    // so the count alone would let the rescue fire and resurrect what the user
    // deleted; only the resolved-on-send marker separates the two.
    await act(async () => {
      await clearLoadedDraft(workspaceId, draftKey)
    })
    await act(async () => {
      panel.rerender()
      card.rerender()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    expect(await db.drafts.where("scope").equals(draftKey).count()).toBe(0)
    expect(card.result.current.content).toEqual(makeDoc("B"))
  })

  it("carries the live attachments into the rescued row", async () => {
    stubAttachments([UPLOADED_ATTACHMENT])

    await upsertLoadedDraft(workspaceId, draftKey, { contentJson: makeDoc("A"), attachments: [] })
    await act(async () => {
      await seedDraftCacheFromIdb(workspaceId)
    })

    const panel = mountComposer()
    const card = mountComposer()
    await act(async () => {
      card.result.current.handleContentChange(makeDoc("B"))
    })
    await act(async () => {
      await panel.result.current.resolveDraft()
    })

    await waitFor(async () => {
      const rows = await db.drafts.where("scope").equals(draftKey).toArray()
      expect(rows.map((row) => row.attachments)).toEqual([
        [{ id: "att_1", filename: "shot.png", mimeType: "image/png", sizeBytes: 1024 }],
      ])
    })
  })
})
