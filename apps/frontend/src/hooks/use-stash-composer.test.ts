import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { createElement, type ReactNode } from "react"
import type { JSONContent } from "@threa/types"
import { db } from "@/db"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import { resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"
import { useDraftComposer } from "./use-draft-composer"
import { useStashComposer, useStashParamDraftRow } from "./use-stash-composer"
import { upsertLoadedDraft, stashLoadedDraft, restoreStashedDraftToComposer } from "./use-draft-message"
import * as draftMessageModule from "./use-draft-message"
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

function useRestoreHarness(key: string = draftKey, scopeId: string = streamId) {
  const composer = useDraftComposer({ workspaceId, draftKey: key, scopeId })
  const stash = useStashComposer(composer, workspaceId, key)
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

  it("refuses to restore a row this scope cannot claim", async () => {
    const { bigId } = await seedStashAndAmbient()
    const restoreSpy = vi.spyOn(draftMessageModule, "restoreStashedDraftToComposer")
    const foreignKey = "board:reply:conv_1"

    // Restore is a pointer move within the row's own scope; adopting a foreign row
    // is chunk 4's job. Until then a foreign id must not migrate the row's scope.
    const { result } = renderHook(() => useRestoreHarness(foreignKey, foreignKey), { wrapper })
    await waitFor(() => expect(result.current.composer.isLoaded).toBe(true))

    await act(async () => {
      await result.current.stash.handleRestoreStashed(bigId)
    })

    expect(restoreSpy).not.toHaveBeenCalled()
    expect((await db.composerLoaded.get(foreignKey))?.draftId).not.toBe(bigId)
    expect((await db.drafts.get(bigId))?.scope).toBe(draftKey)
  })

  it("?stash= auto-restore is consumed only by the host whose scope owns the row", async () => {
    const { bigId } = await seedStashAndAmbient()
    const foreignKey = "board:reply:conv_1"

    function urlWrapper({ children }: { children: ReactNode }) {
      return createElement(MemoryRouter, { initialEntries: [`/?stash=${bigId}`] }, children)
    }

    // A host on a DIFFERENT scope must not consume the param: pointing its own
    // loaded slot at the foreign row would split one draft across two composers.
    const foreign = renderHook(() => useRestoreHarness(foreignKey, foreignKey), { wrapper: urlWrapper })
    await waitFor(() => expect(foreign.result.current.composer.isLoaded).toBe(true))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect((await db.composerLoaded.get(foreignKey))?.draftId).not.toBe(bigId)
    foreign.unmount()

    // The owning host consumes it and checks the row out.
    renderHook(() => useRestoreHarness(), { wrapper: urlWrapper })
    await waitFor(async () => expect((await db.composerLoaded.get(draftKey))?.draftId).toBe(bigId))
  })

  it("restores exactly once when two composers are mounted on the same scope", async () => {
    const { bigId, ambientId } = await seedStashAndAmbient()

    function urlWrapper({ children }: { children: ReactNode }) {
      return createElement(MemoryRouter, { initialEntries: [`/?stash=${bigId}`] }, children)
    }

    // A board card and the conversation panel's footer are the standing case:
    // both mount the same scope, so membership alone let both restore — the
    // second restore would stash the first's just-restored row straight back.
    const restoreSpy = vi.spyOn(draftMessageModule, "restoreStashedDraftToComposer")
    const { result } = renderHook(() => ({ first: useRestoreHarness(), second: useRestoreHarness() }), {
      wrapper: urlWrapper,
    })
    await waitFor(() => expect(result.current.first.composer.isLoaded).toBe(true))
    await waitFor(() => expect(result.current.second.composer.isLoaded).toBe(true))

    expect(result.current.first.composer.isStashClaimant).toBe(true)
    expect(result.current.second.composer.isStashClaimant).toBe(false)

    await waitFor(async () => expect((await db.composerLoaded.get(draftKey))?.draftId).toBe(bigId))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    // One restore, not two: the non-claimant left the param alone.
    expect(restoreSpy.mock.calls.map((call) => call[2])).toEqual([bigId])
    expect((await db.composerLoaded.get(draftKey))?.draftId).toBe(bigId)
    expect(await db.drafts.get(ambientId)).toBeDefined()
  })

  // The conversation panel keys "should I pop the footer composer open?" on this
  // flag. Without it, revisiting a deep link whose draft is already checked out
  // re-opens and refocuses the composer for a restore that has nothing left to do.
  it("reports a deep-linked row as already loaded once its own scope holds it", async () => {
    const { bigId } = await seedStashAndAmbient()

    function urlWrapper({ children }: { children: ReactNode }) {
      return createElement(MemoryRouter, { initialEntries: [`/?stash=${bigId}`] }, children)
    }

    // No composer harness here: mounting one would consume the param itself and
    // race the assertion. The flag is read by hosts that only OBSERVE the param.
    const { result } = renderHook(() => useStashParamDraftRow(workspaceId), { wrapper: urlWrapper })
    await waitFor(() => expect(result.current?.draftId).toBe(bigId))
    expect(result.current?.isLoadedForScope).toBe(false)

    await act(async () => {
      await restoreStashedDraftToComposer(workspaceId, draftKey, bigId)
      await seedDraftCacheFromIdb(workspaceId)
    })
    await waitFor(() => expect(result.current?.isLoadedForScope).toBe(true))
  })
})
