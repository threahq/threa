import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import * as api from "@/api"
import { useGalleryAttachmentUrls } from "./use-gallery-attachment-urls"

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("useGalleryAttachmentUrls", () => {
  it("requests the processed variant for a video", async () => {
    const spy = vi.spyOn(api.attachmentsApi, "getDownloadUrl").mockResolvedValue("https://cdn/processed.mp4")
    const { result } = renderHook(() => useGalleryAttachmentUrls("ws_1", "att_v", "video"))

    await waitFor(() => expect(result.current.get("att_v")).toBe("https://cdn/processed.mp4"))
    expect(spy).toHaveBeenCalledWith("ws_1", "att_v", { variant: "processed" })
  })

  it("falls back to raw bytes when the processed variant 404s", async () => {
    vi.spyOn(api.attachmentsApi, "getDownloadUrl").mockImplementation(
      async (_ws: string, _id: string, opts?: { variant?: string }) => {
        if (opts?.variant === "processed") throw new Error("no processed variant")
        return "https://cdn/raw.mp4"
      }
    )
    const { result } = renderHook(() => useGalleryAttachmentUrls("ws_1", "att_v", "video"))

    await waitFor(() => expect(result.current.get("att_v")).toBe("https://cdn/raw.mp4"))
  })

  it("requests the raw URL (no variant) for a document", async () => {
    const spy = vi.spyOn(api.attachmentsApi, "getDownloadUrl").mockResolvedValue("https://cdn/doc.pdf")
    const { result } = renderHook(() => useGalleryAttachmentUrls("ws_1", "att_d", "document"))

    await waitFor(() => expect(result.current.get("att_d")).toBe("https://cdn/doc.pdf"))
    expect(spy).toHaveBeenCalledWith("ws_1", "att_d")
  })

  it("fetches nothing for a null kind (images / Giphy use deterministic URLs)", async () => {
    const spy = vi.spyOn(api.attachmentsApi, "getDownloadUrl").mockResolvedValue("x")
    const { result } = renderHook(() => useGalleryAttachmentUrls("ws_1", "att_i", null))

    expect(result.current.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it("memoizes per id — re-rendering the same selection does not refetch", async () => {
    const spy = vi.spyOn(api.attachmentsApi, "getDownloadUrl").mockResolvedValue("https://cdn/doc.pdf")
    const { result, rerender } = renderHook(({ id }) => useGalleryAttachmentUrls("ws_1", id, "document"), {
      initialProps: { id: "att_d" as string | null },
    })

    await waitFor(() => expect(result.current.get("att_d")).toBe("https://cdn/doc.pdf"))
    rerender({ id: "att_d" })
    rerender({ id: null })
    rerender({ id: "att_d" })

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
