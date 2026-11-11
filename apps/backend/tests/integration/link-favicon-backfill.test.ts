import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { setupIsolatedTestDatabase } from "./setup"
import {
  LinkFaviconRepository,
  LinkFaviconService,
  LinkPreviewRepository,
  normalizeUrl,
} from "../../src/features/link-previews"
import { plan, processChunk } from "../../src/features/link-previews/favicon-backfill"
import { linkPreviewId, workspaceId } from "../../src/lib/id"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

async function seedPreview(
  pool: Pool,
  wsId: string,
  url: string,
  options: { faviconUrl: string | null; status?: "completed" | "pending" }
): Promise<string> {
  const normalizedUrl = normalizeUrl(url)
  const row = await LinkPreviewRepository.insert(pool, {
    id: linkPreviewId(),
    workspaceId: wsId,
    url,
    normalizedUrl,
    contentType: "website",
  })
  if (options.status !== "pending") {
    await LinkPreviewRepository.updateMetadata(pool, wsId, row.id, {
      status: "completed",
      faviconUrl: options.faviconUrl,
    })
  }
  return normalizedUrl
}

describe("link-favicons backfill against the real schema", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  const wsA = workspaceId()
  const wsB = workspaceId()
  let docsLatest: string
  let portPage: string

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("link_favicon_backfill"))

    await seedPreview(pool, wsA, "https://Docs.Example.com/old", { faviconUrl: "https://docs.example.com/old.ico" })
    docsLatest = await seedPreview(pool, wsA, "https://docs.example.com/new", {
      faviconUrl: "https://docs.example.com/new.png",
    })
    portPage = await seedPreview(pool, wsA, "https://Shop.Example.com:8443/cart", {
      faviconUrl: "https://shop.example.com:8443/icon.png",
    })
    await seedPreview(pool, wsA, "https://cached.example.com/page", { faviconUrl: "https://cached.example.com/i.png" })
    await seedPreview(pool, wsA, "https://pending.example.com/page", {
      faviconUrl: null,
      status: "pending",
    })
    await seedPreview(pool, wsA, "https://noicon.example.com/page", { faviconUrl: null })
    await seedPreview(pool, wsB, "https://other.example.com/page", { faviconUrl: "https://other.example.com/i.png" })

    await LinkFaviconRepository.storeIcon(pool, {
      workspaceId: wsA,
      host: "cached.example.com",
      contentType: "image/png",
      bytes: PNG,
      expiresAt: new Date(Date.now() + 60_000),
    })
  })

  afterEach(() => {
    mock.restore()
  })

  afterAll(async () => {
    await cleanup()
  })

  test("should return one workspace-scoped item per uncached host, newest preview first, when planning", async () => {
    const chunks = await plan({ pool }, wsA)

    expect(chunks).toEqual([
      {
        items: [
          { pageUrl: portPage, faviconUrl: "https://shop.example.com:8443/icon.png" },
          { pageUrl: docsLatest, faviconUrl: "https://docs.example.com/new.png" },
        ],
      },
    ])
  })

  test("should store icons under the hosts linkFaviconHost derives when processing a chunk", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response(PNG, { status: 200 })) as unknown as typeof fetch
    )
    const [chunk] = await plan({ pool }, wsA)

    const result = await processChunk({ pool, linkFaviconService: new LinkFaviconService({ pool }) }, wsA, chunk!)

    expect(result).toEqual({ processed: 2 })
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://shop.example.com:8443/icon.png",
      "https://docs.example.com/new.png",
    ])
    const stored = await Promise.all(
      ["docs.example.com", "shop.example.com:8443"].map((host) => LinkFaviconRepository.find(pool, wsA, host))
    )
    expect(stored.map((row) => ({ host: row?.host, contentType: row?.contentType }))).toEqual([
      { host: "docs.example.com", contentType: "image/png" },
      { host: "shop.example.com:8443", contentType: "image/png" },
    ])
    expect(await plan({ pool }, wsA)).toEqual([])
  })

  test("should plan only its own workspace's hosts when another workspace has previews", async () => {
    expect(await plan({ pool }, wsB)).toEqual([
      { items: [{ pageUrl: "https://other.example.com/page", faviconUrl: "https://other.example.com/i.png" }] },
    ])
  })
})
