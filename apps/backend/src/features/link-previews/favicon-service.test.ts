import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test"
import { LinkFaviconService, sniffFaviconType } from "./favicon-service"
import { LinkFaviconRepository, type LinkFavicon } from "./favicon-repository"
import { FAVICON_RETRY_TTL_MS, FAVICON_TTL_MS, MAX_FAVICON_BYTES } from "./config"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 1, 0])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

const NOW = new Date("2026-11-11T12:00:00.000Z")

const pool = {} as any

function fetchImpl(fn: (input: RequestInfo | URL) => Promise<Response>): typeof fetch {
  return fn as typeof fetch
}

function row(expiresAt: Date): LinkFavicon {
  return {
    workspaceId: "ws_1",
    host: "example.com",
    contentType: "image/png",
    bytes: Buffer.from(PNG),
    fetchedAt: new Date(),
    expiresAt,
  }
}

function imageResponse(bytes: Uint8Array, url: string, contentType = "image/png"): Response {
  const response = new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } })
  Object.defineProperty(response, "url", { value: url })
  return response
}

function spyRepo(existing: LinkFavicon | null) {
  return {
    find: spyOn(LinkFaviconRepository, "find").mockResolvedValue(existing),
    storeIcon: spyOn(LinkFaviconRepository, "storeIcon").mockResolvedValue(),
    recordMiss: spyOn(LinkFaviconRepository, "recordMiss").mockResolvedValue(),
  }
}

describe("LinkFaviconService.ensureForPage", () => {
  afterEach(() => {
    mock.restore()
    setSystemTime()
  })

  test("should not fetch when the host row is still fresh", async () => {
    const repo = spyRepo(row(new Date(Date.now() + 60_000)))
    const fetchSpy = spyOn(globalThis, "fetch")

    await new LinkFaviconService({ pool }).ensureForPage("ws_1", "https://example.com/a", "https://example.com/i.png")

    expect({ fetches: fetchSpy.mock.calls.length, stores: repo.storeIcon.mock.calls.length }).toEqual({
      fetches: 0,
      stores: 0,
    })
  })

  test("should fetch and store the candidate with the 30 day TTL when the row has expired", async () => {
    setSystemTime(NOW)
    const repo = spyRepo(row(new Date(NOW.getTime() - 1000)))
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fetchImpl(async () => imageResponse(PNG, "https://example.com/i.png"))
    )

    await new LinkFaviconService({ pool }).ensureForPage("ws_1", "https://example.com/a", "https://example.com/i.png")

    const stored = repo.storeIcon.mock.calls[0]![1]
    expect({
      fetched: fetchSpy.mock.calls.map((c) => String(c[0])),
      stored: { ...stored, bytes: Array.from(stored.bytes) },
    }).toEqual({
      fetched: ["https://example.com/i.png"],
      stored: {
        workspaceId: "ws_1",
        host: "example.com",
        contentType: "image/png",
        bytes: Array.from(PNG),
        expiresAt: new Date(NOW.getTime() + FAVICON_TTL_MS),
      },
    })
  })

  test("should fall back to /favicon.ico when the first candidate is SVG or HTML", async () => {
    const repo = spyRepo(null)
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fetchImpl(async (input) => {
        const url = String(input)
        if (url.endsWith(".svg")) return imageResponse(SVG, url, "image/png")
        return imageResponse(ICO, url, "text/html")
      })
    )

    await new LinkFaviconService({ pool }).ensureForPage(
      "ws_1",
      "https://Example.com:8443/a",
      "https://cdn.example.com/i.svg"
    )

    expect({
      fetched: fetchSpy.mock.calls.map((c) => String(c[0])),
      stored: repo.storeIcon.mock.calls.map((c) => [c[1].host, c[1].contentType]),
    }).toEqual({
      fetched: ["https://cdn.example.com/i.svg", "https://example.com:8443/favicon.ico"],
      stored: [["example.com:8443", "image/x-icon"]],
    })
  })

  test("should reject the body and record a miss when it exceeds the size cap", async () => {
    const repo = spyRepo(null)
    const big = new Uint8Array(MAX_FAVICON_BYTES + 1)
    big.set(PNG)
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl(async (input) => imageResponse(big, String(input))))

    await new LinkFaviconService({ pool }).ensureForPage("ws_1", "https://example.com/a", "https://example.com/i.png")

    expect({ stores: repo.storeIcon.mock.calls.length, misses: repo.recordMiss.mock.calls.length }).toEqual({
      stores: 0,
      misses: 1,
    })
  })

  test("should never fetch a blocked candidate when it points at an internal address", async () => {
    spyRepo(null)
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fetchImpl(async (input) => imageResponse(PNG, String(input)))
    )

    await new LinkFaviconService({ pool }).ensureForPage(
      "ws_1",
      "https://example.com/a",
      "http://169.254.169.254/i.png"
    )

    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(["https://example.com/favicon.ico"])
  })

  test("should record a miss with the retry TTL when every candidate fails", async () => {
    setSystemTime(NOW)
    const repo = spyRepo(null)
    spyOn(globalThis, "fetch").mockImplementation(
      fetchImpl(async (input) => {
        if (String(input).endsWith(".png")) throw new Error("network down")
        return new Response("nope", { status: 404 })
      })
    )

    await new LinkFaviconService({ pool }).ensureForPage("ws_1", "https://example.com/a", "https://example.com/i.png")

    expect({ misses: repo.recordMiss.mock.calls.map((c) => c[1]), stores: repo.storeIcon.mock.calls.length }).toEqual({
      misses: [{ workspaceId: "ws_1", host: "example.com", expiresAt: new Date(NOW.getTime() + FAVICON_RETRY_TTL_MS) }],
      stores: 0,
    })
  })

  test("should give every candidate the same deadline when the first one fails", async () => {
    spyRepo(null)
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fetchImpl(async () => new Response("nope", { status: 404 }))
    )

    await new LinkFaviconService({ pool }).ensureForPage("ws_1", "https://example.com/a", "https://example.com/i.png")

    const signals = fetchSpy.mock.calls.map((c) => (c[1] as RequestInit).signal)
    expect({
      candidates: signals.length,
      shared: signals[0] instanceof AbortSignal && signals[0] === signals[1],
    }).toEqual({
      candidates: 2,
      shared: true,
    })
  })

  test("should fetch once when two links on the same host refresh concurrently", async () => {
    const repo = spyRepo(null)
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fetchImpl(async (input) => imageResponse(PNG, String(input)))
    )
    const service = new LinkFaviconService({ pool })

    await Promise.all([
      service.ensureForPage("ws_1", "https://example.com/a", "https://example.com/i.png"),
      service.ensureForPage("ws_1", "https://example.com/b", "https://example.com/i.png"),
    ])

    expect({
      fetched: fetchSpy.mock.calls.map((c) => String(c[0])),
      stores: repo.storeIcon.mock.calls.length,
    }).toEqual({ fetched: ["https://example.com/i.png"], stores: 1 })
  })
})

describe("sniffFaviconType", () => {
  test("should identify each accepted format from magic bytes when headers are ignored", () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    expect({
      png: sniffFaviconType(PNG),
      jpeg: sniffFaviconType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
      gif: sniffFaviconType(new TextEncoder().encode("GIF89a")),
      webp: sniffFaviconType(webp),
      ico: sniffFaviconType(ICO),
      svg: sniffFaviconType(SVG),
      html: sniffFaviconType(new TextEncoder().encode("<html>")),
      empty: sniffFaviconType(new Uint8Array()),
    }).toEqual({
      png: "image/png",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      ico: "image/x-icon",
      svg: null,
      html: null,
      empty: null,
    })
  })
})

describe("LinkFaviconService.getIcon", () => {
  afterEach(() => {
    mock.restore()
  })

  test("should return null when the row has no bytes", async () => {
    spyRepo({ ...row(new Date()), contentType: null, bytes: null })
    expect(await new LinkFaviconService({ pool }).getIcon("ws_1", "example.com")).toBeNull()
  })
})
