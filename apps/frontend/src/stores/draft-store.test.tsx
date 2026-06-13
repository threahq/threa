import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  resetDraftStoreCache,
  seedDraftCache,
  useComposerLoadedFromStore,
  useDraftsFromStore,
  useDraftScratchpadsFromStore,
} from "./draft-store"

describe("draft store cache subscriptions", () => {
  beforeEach(() => {
    resetDraftStoreCache()
  })

  it("rerenders draft readers when the draft cache is seeded", () => {
    const { result } = renderHook(() => useDraftsFromStore("workspace_1"))

    expect(result.current).toEqual([])

    act(() => {
      seedDraftCache("workspace_1", {
        scratchpads: [],
        loaded: [],
        drafts: [
          {
            id: "draft_1",
            workspaceId: "workspace_1",
            scope: "stream:stream_1",
            contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
            attachments: [],
            clientUpdatedAt: Date.now(),
          },
        ],
      })
    })

    expect(result.current.map((draft) => draft.id)).toEqual(["draft_1"])
  })

  it("rerenders composer-loaded readers when the draft cache is seeded", () => {
    const { result } = renderHook(() => useComposerLoadedFromStore("workspace_1"))

    expect(result.current).toEqual([])

    act(() => {
      seedDraftCache("workspace_1", {
        scratchpads: [],
        drafts: [],
        loaded: [{ scope: "stream:stream_1", workspaceId: "workspace_1", draftId: "draft_1" }],
      })
    })

    expect(result.current.map((row) => row.draftId)).toEqual(["draft_1"])
  })

  it("rerenders scratchpad readers when the draft cache is seeded", () => {
    const { result } = renderHook(() => useDraftScratchpadsFromStore("workspace_1"))

    expect(result.current).toEqual([])

    act(() => {
      seedDraftCache("workspace_1", {
        scratchpads: [
          {
            id: "draft_1",
            workspaceId: "workspace_1",
            displayName: "Scratchpad",
            companionMode: "off",
            createdAt: Date.now(),
          },
        ],
        drafts: [],
        loaded: [],
      })
    })

    expect(result.current.map((draft) => draft.id)).toEqual(["draft_1"])
  })
})
