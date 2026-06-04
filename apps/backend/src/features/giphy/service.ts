import type { GiphyGif } from "@threa/types"
import type { GiphyConfig } from "../../lib/env"
import { GiphyClient } from "./client"
import { GIPHY_ALLOWED_MEDIA_HOST_SUFFIX, GIPHY_FETCH_TIMEOUT_MS, GIPHY_MAX_FILE_BYTES } from "./config"

export interface GiphyServiceDeps {
  config: GiphyConfig
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export interface GiphyPage {
  items: GiphyGif[]
  nextOffset: number | null
}

export interface GiphyFile {
  buffer: Buffer
  mimeType: string
  sizeBytes: number
  filename: string
}

export class GiphyDisabledError extends Error {
  constructor() {
    super("Giphy is not configured")
    this.name = "GiphyDisabledError"
  }
}

/**
 * Orchestrates the Giphy picker: gates on whether a key is configured, exposes
 * search/trending, and downloads the chosen GIF's bytes for re-upload. The
 * client is constructed once (only when enabled) and reused — there is no
 * per-call dependency assembly (INV-13).
 */
export class GiphyService {
  private readonly client: GiphyClient | null
  private readonly fetchImpl: typeof fetch

  constructor(deps: GiphyServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.client = deps.config.apiKey ? new GiphyClient(deps.config.apiKey, this.fetchImpl) : null
  }

  isEnabled(): boolean {
    return this.client !== null
  }

  async search(query: string, options: { limit?: number; offset?: number }): Promise<GiphyPage> {
    return this.requireClient().search(query, options)
  }

  async trending(options: { limit?: number; offset?: number }): Promise<GiphyPage> {
    return this.requireClient().trending(options)
  }

  /**
   * Resolve a GIF by id server-side and download its bytes. The URL is never
   * taken from the caller — it's re-resolved through the Giphy API and its host
   * validated against {@link GIPHY_ALLOWED_MEDIA_HOST_SUFFIX} before fetching
   * (SSRF guard), and the body is capped at {@link GIPHY_MAX_FILE_BYTES}.
   * Returns null when the id is unknown.
   */
  async fetchGif(id: string): Promise<GiphyFile | null> {
    const client = this.requireClient()
    const url = await client.resolveDownloadUrl(id)
    if (!url) return null

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(GIPHY_ALLOWED_MEDIA_HOST_SUFFIX)) {
      throw new Error(`Refusing to download Giphy media from unexpected host: ${parsed.hostname}`)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GIPHY_FETCH_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(parsed.toString(), { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`Giphy media download failed with status ${response.status}`)
      }

      const declaredLength = Number(response.headers.get("content-length"))
      if (Number.isFinite(declaredLength) && declaredLength > GIPHY_MAX_FILE_BYTES) {
        throw new Error(`Giphy media exceeds size cap (${declaredLength} bytes)`)
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength > GIPHY_MAX_FILE_BYTES) {
        throw new Error(`Giphy media exceeds size cap (${buffer.byteLength} bytes)`)
      }

      return {
        buffer,
        mimeType: "image/gif",
        sizeBytes: buffer.byteLength,
        filename: `giphy-${id}.gif`,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private requireClient(): GiphyClient {
    if (!this.client) throw new GiphyDisabledError()
    return this.client
  }
}
