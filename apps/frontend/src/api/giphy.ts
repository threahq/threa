import { api, API_BASE, parseApiError } from "./client"
import type { GiphyConfigResponse, GiphySearchResponse } from "@threa/types"

/**
 * Giphy picker API. Search/trending/config are JSON; the chosen GIF's bytes are
 * pulled from the same-origin proxy and wrapped in a `File` so they can ride the
 * existing attachment-upload path (no Giphy-CDN CORS, key stays server-side).
 */
export const giphyApi = {
  getConfig(workspaceId: string, options?: { signal?: AbortSignal }): Promise<GiphyConfigResponse> {
    return api.get<GiphyConfigResponse>(`/api/workspaces/${workspaceId}/giphy/config`, options)
  },

  search(
    workspaceId: string,
    query: string,
    options?: { offset?: number; signal?: AbortSignal }
  ): Promise<GiphySearchResponse> {
    const params = new URLSearchParams({ q: query })
    if (options?.offset) params.set("offset", String(options.offset))
    return api.get<GiphySearchResponse>(`/api/workspaces/${workspaceId}/giphy/search?${params.toString()}`, {
      signal: options?.signal,
    })
  },

  trending(workspaceId: string, options?: { offset?: number; signal?: AbortSignal }): Promise<GiphySearchResponse> {
    const params = new URLSearchParams()
    if (options?.offset) params.set("offset", String(options.offset))
    const qs = params.toString()
    return api.get<GiphySearchResponse>(`/api/workspaces/${workspaceId}/giphy/trending${qs ? `?${qs}` : ""}`, {
      signal: options?.signal,
    })
  },

  /** Download the chosen GIF's bytes as a `File` ready for the upload pipeline. */
  async fetchGifFile(workspaceId: string, gifId: string): Promise<File> {
    const response = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/giphy/${gifId}/file`, {
      credentials: "include",
    })
    if (!response.ok) {
      throw await parseApiError(response, { code: "GIPHY_ERROR", message: "Failed to load GIF" })
    }
    const blob = await response.blob()
    return new File([blob], `giphy-${gifId}.gif`, { type: blob.type || "image/gif" })
  },
}
