import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { AttachmentRef } from "@/lib/crypto/attachment-crypto"
import * as attachmentCache from "@/lib/crypto/attachment-cache"
import { useDecryptedAttachment } from "./use-decrypted-attachment"

const WORKSPACE_ID = "ws_1"

function ref(): AttachmentRef {
  return {
    attachmentId: "att_1",
    key: "k",
    iv: "iv",
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 10,
  } as AttachmentRef
}

beforeEach(() => {
  // jsdom doesn't implement object URLs; stub them so the ready path can render.
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:stub", revokeObjectURL: () => {} })
  vi.spyOn(attachmentCache, "subscribeToAttachmentBytes").mockReturnValue(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("useDecryptedAttachment", () => {
  it("reports pending and fires a fetch+decrypt request on a cache miss", () => {
    vi.spyOn(attachmentCache, "getCachedAttachmentBytes").mockReturnValue(undefined)
    const request = vi.spyOn(attachmentCache, "requestAttachmentBytes").mockResolvedValue({
      status: "pending",
      value: null,
    })

    const { result } = renderHook(() => useDecryptedAttachment(WORKSPACE_ID, ref()))

    expect(result.current).toEqual({ status: "pending" })
    expect(request).toHaveBeenCalledWith("att_1", expect.any(Function))
  })

  it("exposes a ready object URL once the bytes are cached", () => {
    vi.spyOn(attachmentCache, "getCachedAttachmentBytes").mockReturnValue({
      status: "decrypted",
      value: new Blob(["bytes"], { type: "image/png" }),
    })
    vi.spyOn(attachmentCache, "requestAttachmentBytes").mockResolvedValue({ status: "pending", value: null })

    const { result } = renderHook(() => useDecryptedAttachment(WORKSPACE_ID, ref()))

    expect(result.current).toEqual({ status: "ready", url: "blob:stub" })
  })

  it("reports failed when the cached open failed", () => {
    vi.spyOn(attachmentCache, "getCachedAttachmentBytes").mockReturnValue({ status: "failed", value: null })
    const request = vi.spyOn(attachmentCache, "requestAttachmentBytes").mockResolvedValue({
      status: "failed",
      value: null,
    })

    const { result } = renderHook(() => useDecryptedAttachment(WORKSPACE_ID, ref()))

    expect(result.current).toEqual({ status: "failed" })
    // The hook's request effect only fires on undefined/pending, so a cached failure
    // isn't auto-re-requested here; the cache is `retryFailed`, so the retry is driven
    // by the file-download button calling `requestAttachmentBytes` again.
    expect(request).not.toHaveBeenCalled()
  })
})
