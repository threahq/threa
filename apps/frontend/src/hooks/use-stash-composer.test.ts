import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { createElement, type ReactNode } from "react"
import type { JSONContent } from "@threa/types"
import { db } from "@/db"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import { resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"
import { useDraftComposer } from "./use-draft-composer"
import { useStashComposer } from "./use-stash-composer"
import { upsertLoadedDraft, stashLoadedDraft } from "./use-draft-message"
import * as currentUserHook from "./use-current-workspace-user-id"
import * as e2eSessionStore from "@/stores/e2e-session-store"

// Hook-level test (renderHook), like its siblings use-draft-message.test.ts and
// use-draft-composer.test.ts: it pins the no-limbo DATA invariant of restore
// against the real data layer (fake-indexeddb). It deliberately does not mount a
// component — RichEditor is mocked suite-wide, so a mounted flow wouldn't exercise
// the real editor sync anyway; that hop is unit-tested in apply-external-content.test.ts.
// The only seams are the viewer id + E2E session, defaulted to "no viewer / locked"
// so the plaintext path runs without an AuthProvider.
const LOCKED_SESSION = {
  status: "locked",
  keyId: null,
  publicKey: null,
  privateKey: null,
  deviceTrusted: false,
  error: null,
} as ReturnType<typeof e2eSessionStore.useE2eSession>

const workspaceId = "ws_123"
const streamId = "stream_456"
const draftKey = `stream:${streamId}`

/**
 * A faithful "large message with an attachment": several text blocks plus an
 * inline `attachmentReference` chip — the shape of the real scratchpad draft
 * that failed to restore (a pasted image embedded in a multi-paragraph note).
 */
const BIG_BODY: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "First paragraph of a long note." }] },
    { type: "paragraph", content: [{ type: "text", text: "Second paragraph with more detail." }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Here is the screenshot " },
        {
          type: "attachmentReference",
          attrs: {
            id: "attach_big",
            filename: "pasted-image-1.png",
            mimeType: "image/png",
            sizeBytes: 380784,
            status: "uploaded",
            imageIndex: 1,
            error: null,
          },
        },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "Closing thoughts." }] },
  ],
}
const BIG_ATTACHMENT = { id: "attach_big", filename: "pasted-image-1.png", mimeType: "image/png", sizeBytes: 380784 }
const AMBIENT_BODY: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "ambient draft" }] }],
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(MemoryRouter, { initialEntries: ["/"] }, children)
}

function useRestoreHarness() {
  const composer = useDraftComposer({ workspaceId, draftKey, scopeId: streamId })
  const stash = useStashComposer(composer, workspaceId, draftKey)
  return { composer, stash }
}

describe("stash restore — no-limbo invariant (real data layer)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    resetDraftStoreCache()
    resetDraftResolutionGuard()
    await db.drafts.clear()
    await db.composerLoaded.clear()
    await db.pendingOperations.clear()
    vi.spyOn(currentUserHook, "useCurrentWorkspaceUserId").mockReturnValue(null)
    vi.spyOn(e2eSessionStore, "useE2eSession").mockReturnValue(LOCKED_SESSION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Seed the scope with a stashed "big" draft (body + inline attachment) and a
   * separate loaded ambient draft — the exact shape of the reported bug (a stash
   * pile where the user restores the long, attachment-carrying entry).
   */
  async function seedStashAndAmbient(): Promise<{ bigId: string; ambientId: string }> {
    const big = await upsertLoadedDraft(workspaceId, draftKey, {
      contentJson: BIG_BODY,
      attachments: [BIG_ATTACHMENT],
    })
    await stashLoadedDraft(workspaceId, draftKey) // detach -> big becomes a stash entry
    const ambient = await upsertLoadedDraft(workspaceId, draftKey, { contentJson: AMBIENT_BODY, attachments: [] })
    await seedDraftCacheFromIdb(workspaceId)
    return { bigId: big.id, ambientId: ambient.id }
  }

  it("restores the big draft's body into the composer AND keeps the row recoverable", async () => {
    const { bigId, ambientId } = await seedStashAndAmbient()

    const { result } = renderHook(() => useRestoreHarness(), { wrapper })

    // Composer starts on the ambient draft.
    await waitFor(() => expect(result.current.composer.content).toEqual(AMBIENT_BODY))

    await act(async () => {
      await result.current.stash.handleRestoreStashed(bigId)
    })

    // 1) The restored body is VISIBLE in the composer (not blank) — no limbo.
    await waitFor(() => expect(result.current.composer.content).toEqual(BIG_BODY))
    // 2) Its attachment chip came back with it.
    await waitFor(() => expect(result.current.composer.pendingAttachments.map((a) => a.id)).toContain("attach_big"))
    // 3) The draft row was never destroyed — it is still on disk and now the loaded one.
    expect(await db.drafts.get(bigId)).toBeDefined()
    expect((await db.composerLoaded.get(draftKey))?.draftId).toBe(bigId)
    // 4) The previously-loaded ambient draft is preserved as a stash sibling (swap, not clobber).
    await waitFor(() => expect(result.current.stash.drafts.some((d) => d.id === ambientId)).toBe(true))
  })
})
