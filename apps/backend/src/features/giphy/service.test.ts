import { describe, expect, it, mock } from "bun:test"
import { GiphyService } from "./service"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

describe("GiphyService", () => {
  it("is disabled without an API key", () => {
    const service = new GiphyService({ config: { enabled: false, apiKey: "" } })
    expect(service.isEnabled()).toBe(false)
  })

  it("is enabled with an API key", () => {
    const service = new GiphyService({ config: { enabled: true, apiKey: "key" } })
    expect(service.isEnabled()).toBe(true)
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

  it("reports no next offset when the result set is exhausted", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(jsonResponse({ data: [], pagination: { total_count: 0, count: 0, offset: 0 } }))
    ) as unknown as typeof fetch
    const service = new GiphyService({ config: { enabled: true, apiKey: "key" }, fetchImpl })
    const page = await service.trending({})
    expect(page.items).toEqual([])
    expect(page.nextOffset).toBeNull()
  })
})
