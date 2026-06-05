import { describe, expect, it, mock } from "bun:test"
import { createGiphyHandlers } from "./handlers"
import type { GiphyService } from "./service"

function createResponse() {
  const res: {
    statusCode?: number
    body?: unknown
    headers: Record<string, string>
    status: ReturnType<typeof mock>
    json: ReturnType<typeof mock>
    send: ReturnType<typeof mock>
    setHeader: ReturnType<typeof mock>
  } = {
    headers: {},
  } as never
  res.status = mock((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = mock((body: unknown) => {
    res.body = body
    return res
  })
  res.send = mock((body: unknown) => {
    res.body = body
    return res
  })
  res.setHeader = mock((key: string, value: string) => {
    res.headers[key] = value
    return res
  })
  return res
}

/** Captures the error forwarded to Express's error middleware via `next(err)`. */
function createNext() {
  const calls: unknown[] = []
  const next = mock((err?: unknown) => {
    calls.push(err)
  })
  return { next, errorStatus: () => (calls[0] as { status?: number } | undefined)?.status }
}

describe("giphy handlers", () => {
  it("reports enabled state from the service", () => {
    const giphyService = { isEnabled: mock(() => true) } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()

    handlers.getConfig({} as never, res as never)

    expect(res.body).toEqual({ enabled: true })
  })

  it("forwards a 404 HttpError for search when the feature is disabled", async () => {
    const giphyService = {
      isEnabled: mock(() => false),
      search: mock(() => Promise.resolve({ items: [], nextOffset: null })),
    } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()
    const { next, errorStatus } = createNext()

    await handlers.search({ query: { q: "cats" } } as never, res as never, next as never)

    expect(errorStatus()).toBe(404)
    expect(giphyService.search).not.toHaveBeenCalled()
  })

  it("forwards a 400 HttpError for search when the query is missing", async () => {
    const giphyService = {
      isEnabled: mock(() => true),
      search: mock(() => Promise.resolve({ items: [], nextOffset: null })),
    } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()
    const { next, errorStatus } = createNext()

    await handlers.search({ query: {} } as never, res as never, next as never)

    expect(errorStatus()).toBe(400)
    expect(giphyService.search).not.toHaveBeenCalled()
  })

  it("returns search results with the next offset", async () => {
    const page = {
      items: [{ id: "abc", title: "cat", previewUrl: "https://media.giphy.com/x.gif", width: 200, height: 150 }],
      nextOffset: 24,
    }
    const giphyService = {
      isEnabled: mock(() => true),
      search: mock(() => Promise.resolve(page)),
    } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()
    const { next } = createNext()

    await handlers.search({ query: { q: "cats", offset: "0" } } as never, res as never, next as never)

    expect(giphyService.search).toHaveBeenCalledWith("cats", { offset: 0, limit: 24 })
    expect(res.body).toEqual(page)
  })

  it("forwards a 404 HttpError for trending when the feature is disabled", async () => {
    const giphyService = {
      isEnabled: mock(() => false),
      trending: mock(() => Promise.resolve({ items: [], nextOffset: null })),
    } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()
    const { next, errorStatus } = createNext()

    await handlers.trending({ query: {} } as never, res as never, next as never)

    expect(errorStatus()).toBe(404)
    expect(giphyService.trending).not.toHaveBeenCalled()
  })

  it("returns trending results and forwards pagination params", async () => {
    const page = {
      items: [{ id: "xyz", title: "dog", previewUrl: "https://media.giphy.com/d.gif", width: 200, height: 150 }],
      nextOffset: null,
    }
    const giphyService = {
      isEnabled: mock(() => true),
      trending: mock(() => Promise.resolve(page)),
    } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()
    const { next } = createNext()

    await handlers.trending({ query: { offset: "24" } } as never, res as never, next as never)

    expect(giphyService.trending).toHaveBeenCalledWith({ offset: 24, limit: 24 })
    expect(res.body).toEqual(page)
  })

  it("streams GIF bytes with the right headers", async () => {
    const buffer = Buffer.from([0x47, 0x49, 0x46])
    const giphyService = {
      isEnabled: mock(() => true),
      fetchGif: mock(() =>
        Promise.resolve({ buffer, mimeType: "image/gif", sizeBytes: buffer.byteLength, filename: "giphy-abc.gif" })
      ),
    } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()
    const { next } = createNext()

    await handlers.file({ params: { gifId: "abc" } } as never, res as never, next as never)

    expect(res.headers["Content-Type"]).toBe("image/gif")
    expect(res.headers["Content-Length"]).toBe("3")
    expect(res.body).toBe(buffer)
  })

  it("forwards a 404 HttpError when the GIF id resolves to no media", async () => {
    const giphyService = {
      isEnabled: mock(() => true),
      fetchGif: mock(() => Promise.resolve(null)),
    } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()
    const { next, errorStatus } = createNext()

    await handlers.file({ params: { gifId: "missing" } } as never, res as never, next as never)

    expect(errorStatus()).toBe(404)
    expect(giphyService.fetchGif).toHaveBeenCalledWith("missing")
  })

  it("forwards a 400 HttpError for the file endpoint with a malformed id", async () => {
    const giphyService = {
      isEnabled: mock(() => true),
      fetchGif: mock(() => Promise.resolve(null)),
    } as unknown as GiphyService
    const handlers = createGiphyHandlers({ giphyService })
    const res = createResponse()
    const { next, errorStatus } = createNext()

    await handlers.file({ params: { gifId: "../../etc/passwd" } } as never, res as never, next as never)

    expect(errorStatus()).toBe(400)
    expect(giphyService.fetchGif).not.toHaveBeenCalled()
  })
})
