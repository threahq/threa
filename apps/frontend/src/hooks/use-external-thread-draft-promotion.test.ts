import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import * as draftMessageModule from "./use-draft-message"
import * as syncEngineModule from "@/sync/sync-engine"
import { useExternalThreadDraftPromotion } from "./use-external-thread-draft-promotion"

describe("useExternalThreadDraftPromotion", () => {
  const flushDraft = vi.fn()
  const setIsSending = vi.fn()
  const onPromoted = vi.fn()
  const kickOperationQueue = vi.fn()

  beforeEach(() => {
    vi.restoreAllMocks()
    flushDraft.mockReset().mockResolvedValue(undefined)
    setIsSending.mockReset()
    onPromoted.mockReset()
    kickOperationQueue.mockReset()
    vi.spyOn(draftMessageModule, "relocateLoadedDraft").mockResolvedValue(undefined)
    vi.spyOn(draftMessageModule, "rescopeScopeDrafts").mockResolvedValue(undefined)
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      kickOperationQueue,
    } as unknown as ReturnType<typeof syncEngineModule.useOptionalSyncEngine>)
  })

  it("relocates the live card draft and re-scopes stash siblings before navigating", async () => {
    renderHook(() =>
      useExternalThreadDraftPromotion({
        workspaceId: "ws_1",
        isDraft: true,
        anchorId: "event_card",
        externalThreadId: "stream_thread",
        flushDraft,
        setIsSending,
        onPromoted,
      })
    )

    await waitFor(() => expect(onPromoted).toHaveBeenCalledWith("stream_thread"))
    expect(setIsSending).toHaveBeenCalledWith(true)
    expect(flushDraft).toHaveBeenCalledOnce()
    expect(draftMessageModule.relocateLoadedDraft).toHaveBeenCalledWith(
      "ws_1",
      "thread:event_card",
      "stream:stream_thread"
    )
    expect(draftMessageModule.rescopeScopeDrafts).toHaveBeenCalledWith(
      "ws_1",
      "thread:event_card",
      "stream:stream_thread"
    )
    expect(kickOperationQueue).toHaveBeenCalledOnce()
  })

  it("keeps the draft panel open when relocation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.mocked(draftMessageModule.relocateLoadedDraft).mockRejectedValue(new Error("IDB failed"))

    renderHook(() =>
      useExternalThreadDraftPromotion({
        workspaceId: "ws_1",
        isDraft: true,
        anchorId: "event_card",
        externalThreadId: "stream_thread",
        flushDraft,
        setIsSending,
        onPromoted,
      })
    )

    await waitFor(() => expect(setIsSending).toHaveBeenLastCalledWith(false))
    expect(onPromoted).not.toHaveBeenCalled()
  })
})
