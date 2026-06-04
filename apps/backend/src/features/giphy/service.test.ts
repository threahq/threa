import { describe, expect, it, mock } from "bun:test"
import { GiphyService } from "./service"
import { GIPHY_MAX_FILE_BYTES } from "./config"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

describe("GiphyService", () => {
  it("is disabled without an API key", () => {
    const service = new GiphyService({ config: { enabled: false, apiKey: "" } })
    expect(service.isEnabled()).toBe(false)
  })

  it("maps search results and forwards the query", async () => {
    const fetchImpl = mock((url: string) => {
      expect(url).toContain("/search?")
      expect(url).toContain("q=cats")
      return Promise.resolve(
        jsonResponse({
          data: [
            {
              id: "abc",
              title: "cat",
              images: { fixed_width: { url: "https://media.giphy.com/c.gif", width: "200", height: "150" } },
            },
          ],
          pagination: { total_count: 100, count: 1, offset: 0 },
        })
      )
    }) as unknown as typeof fetch

    const service = new GiphyService({ config: { enabled: true, apiKey: "key" }, fetchImpl })
    const page = await service.search("cats", {})

    expect(page.items).toEqual([
      { id: "abc", title: "cat", previewUrl: "https://media.giphy.com/c.gif", width: 200, height: 150 },
    ])
    expect(page.nextOffset).toBe(1)
  })

  it("downloads bytes for a resolved GIF and caps them at image/gif", async () => {
    const gifBytes = Buffer.from([0x47, 0x49, 0x46, 0x38])
    const fetchImpl = mock((url: string) => {
      if (url.includes("/abc?")) {
        return Promise.resolve(
          jsonResponse({ data: { id: "abc", images: { downsized: { url: "https://media2.giphy.com/abc.gif" } } } })
        )
      }
      return Promise.resolve(new Response(gifBytes, { status: 200 }))
    }) as unknown as typeof fetch

    const service = new GiphyService({ config: { enabled: true, apiKey: "key" }, fetchImpl })
    const file = await service.fetchGif("abc")

    expect(file).not.toBeNull()
    expect(file?.mimeType).toBe("image/gif")
    expect(file?.filename).toBe("giphy-abc.gif")
    expect(file?.sizeBytes).toBe(gifBytes.byteLength)
  })

  it("refuses to download media from a non-giphy host (SSRF guard)", async () => {
    const fetchImpl = mock((url: string) => {
      if (url.includes("/abc?")) {
        return Promise.resolve(
          jsonResponse({ data: { id: "abc", images: { downsized: { url: "https://evil.example.com/x.gif" } } } })
        )
      }
      throw new Error("should not fetch the malicious host")
    }) as unknown as typeof fetch

    const service = new GiphyService({ config: { enabled: true, apiKey: "key" }, fetchImpl })
    await expect(service.fetchGif("abc")).rejects.toThrow(/unexpected host/)
  })

  it("rejects media whose declared length exceeds the cap", async () => {
    const fetchImpl = mock((url: string) => {
      if (url.includes("/abc?")) {
        return Promise.resolve(
          jsonResponse({ data: { id: "abc", images: { downsized: { url: "https://media.giphy.com/abc.gif" } } } })
        )
      }
      return Promise.resolve(
        new Response(Buffer.from([0]), {
          status: 200,
          headers: { "content-length": String(GIPHY_MAX_FILE_BYTES + 1) },
        })
      )
    }) as unknown as typeof fetch

    const service = new GiphyService({ config: { enabled: true, apiKey: "key" }, fetchImpl })
    await expect(service.fetchGif("abc")).rejects.toThrow(/size cap/)
  })

  it("returns null when the GIF id is unknown", async () => {
    const fetchImpl = mock(() => Promise.resolve(jsonResponse({ data: null }))) as unknown as typeof fetch
    const service = new GiphyService({ config: { enabled: true, apiKey: "key" }, fetchImpl })
    expect(await service.fetchGif("missing")).toBeNull()
  })
})
