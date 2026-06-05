import type { GiphyGif } from "@threa/types"
import { GIPHY_API_BASE, GIPHY_FETCH_TIMEOUT_MS, GIPHY_PAGE_SIZE, GIPHY_RATING } from "./config"

/** The shape we care about from a Giphy GIF object's `images` map. */
interface GiphyRendition {
  url?: string
  width?: string
  height?: string
}

interface GiphyApiGif {
  id?: string
  title?: string
  images?: Record<string, GiphyRendition>
}

interface GiphyListResponse {
  data?: GiphyApiGif[]
  pagination?: { total_count?: number; count?: number; offset?: number }
}

export interface GiphyPage {
  items: GiphyGif[]
  /** Offset for the next page, or null when there are no more results. */
  nextOffset: number | null
}

export class GiphyApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = "GiphyApiError"
  }
}

/**
 * Thin wrapper over the Giphy REST API. Holds the API key, parses the subset of
 * each response we need, and maps GIFs to the {@link GiphyGif} wire shape. `fetch`
 * is injectable so tests can drive it without network access.
 */
export class GiphyClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async search(query: string, options: { limit?: number; offset?: number } = {}): Promise<GiphyPage> {
    const params = this.baseParams(options)
    params.set("q", query)
    const body = await this.getJson<GiphyListResponse>(`/search?${params.toString()}`)
    return this.toPage(body)
  }

  async trending(options: { limit?: number; offset?: number } = {}): Promise<GiphyPage> {
    const params = this.baseParams(options)
    const body = await this.getJson<GiphyListResponse>(`/trending?${params.toString()}`)
    return this.toPage(body)
  }

  private baseParams(options: { limit?: number; offset?: number }): URLSearchParams {
    return new URLSearchParams({
      api_key: this.apiKey,
      limit: String(options.limit ?? GIPHY_PAGE_SIZE),
      offset: String(options.offset ?? 0),
      rating: GIPHY_RATING,
      bundle: "messaging_non_clips",
    })
  }

  private async getJson<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GIPHY_FETCH_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(`${GIPHY_API_BASE}${path}`, { signal: controller.signal })
      if (!response.ok) {
        throw new GiphyApiError(`Giphy request failed with status ${response.status}`, response.status)
      }
      return (await response.json()) as T
    } finally {
      clearTimeout(timeout)
    }
  }

  private toPage(body: GiphyListResponse): GiphyPage {
    const items = (body.data ?? []).map((gif) => this.toGif(gif)).filter((gif): gif is GiphyGif => gif !== null)

    const pagination = body.pagination
    const nextOffset =
      pagination &&
      typeof pagination.offset === "number" &&
      typeof pagination.count === "number" &&
      typeof pagination.total_count === "number" &&
      pagination.offset + pagination.count < pagination.total_count
        ? pagination.offset + pagination.count
        : null

    return { items, nextOffset }
  }

  private toGif(gif: GiphyApiGif): GiphyGif | null {
    const id = gif.id
    const preview = gif.images?.fixed_width ?? gif.images?.downsized
    const url = preview?.url
    if (!id || !url) return null
    const width = Number(preview?.width)
    const height = Number(preview?.height)
    return {
      id,
      title: gif.title ?? "",
      previewUrl: url,
      width: Number.isFinite(width) && width > 0 ? width : 200,
      height: Number.isFinite(height) && height > 0 ? height : 200,
    }
  }
}
