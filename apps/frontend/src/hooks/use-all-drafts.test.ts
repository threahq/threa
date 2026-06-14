import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import type { JSONContent } from "@threa/types"
import { db, type CachedDraft } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import * as syncEngineModule from "@/sync/sync-engine"
import { useAllDrafts } from "./use-all-drafts"

const workspaceId = "ws_1"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})

function syncedDraft(overrides: Partial<CachedDraft> = {}): CachedDraft {
  return {
    id: "draft_s1",
    workspaceId,
    scope: "stream:stream_1",
    contentJson: makeDoc("a synced draft"),
    attachments: [],
    clientUpdatedAt: 1000,
    // Confirmed by the server at least once, so a local delete must mirror up.
    baseVersion: 2,
    ...overrides,
  }
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return { wrapper }
}

async function pendingDeleteIds(): Promise<string[]> {
  const ops = await db.pendingOperations.where("type").equals("delete_draft").toArray()
  return ops.map((op) => op.payload.draftId as string)
}

beforeEach(async () => {
  vi.restoreAllMocks()
  resetDraftStoreCache()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.pendingOperations.clear()
  await db.draftScratchpads.clear()
})

describe("useAllDrafts deleteDraft", () => {
  it("kicks the operation queue so a Drafts-view delete propagates to other devices", async () => {
    const kickOperationQueue = vi.fn()
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      kickOperationQueue,
    } as unknown as syncEngineModule.SyncEngine)

    // A synced stash draft (not the loaded one — no composerLoaded pointer).
    await db.drafts.add(syncedDraft({ id: "draft_s1" }))

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await act(async () => {
      await result.current.deleteDraft("draft_s1")
    })

    // Local row gone, a CAS-safe server delete queued, AND the queue kicked so
    // the delete drains now instead of waiting for the next reconnect (without
    // the kick the row survives server-side and every other device keeps it).
    expect(await db.drafts.get("draft_s1")).toBeUndefined()
    expect(await pendingDeleteIds()).toContain("draft_s1")
    expect(kickOperationQueue).toHaveBeenCalled()
  })

  it("kicks the queue when deleting the loaded draft too", async () => {
    const kickOperationQueue = vi.fn()
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      kickOperationQueue,
    } as unknown as syncEngineModule.SyncEngine)

    const scope = "stream:stream_2"
    await db.drafts.add(syncedDraft({ id: "draft_loaded", scope }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_loaded" })

    const { wrapper } = createWrapper()
    const { result } = renderHook(() => useAllDrafts(workspaceId), { wrapper })

    await act(async () => {
      await result.current.deleteDraft("draft_loaded")
    })

    expect(await db.drafts.get("draft_loaded")).toBeUndefined()
    // The unified delete path clears the loaded pointer too, so the composer
    // empties instead of dangling at a missing row.
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
    expect(await pendingDeleteIds()).toContain("draft_loaded")
    expect(kickOperationQueue).toHaveBeenCalled()
  })
})
