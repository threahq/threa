import { api } from "./client"
import type { GiphyConfigResponse, GiphySearchResponse } from "@threa/types"

/**
 * Giphy picker API. Search/trending/config proxy through the backend so the API
 * key stays server-side; the chosen GIF is then embedded by its CDN URL (no byte
 * download/upload).
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
}
