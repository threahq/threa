import { api } from "./client"
import type { LinkPreviewSummary, InAppLinkPreviewData } from "@threahq/types"

export interface LinkPreviewWithDismissed extends LinkPreviewSummary {
  dismissed: boolean
}

const inFlightMessagePreviewRequests = new Map<string, Promise<LinkPreviewWithDismissed[]>>()
const inFlightResolvedInAppLinkRequests = new Map<string, Promise<InAppLinkPreviewData>>()
const inFlightResolvedInAppUrlRequests = new Map<string, Promise<InAppLinkPreviewData>>()

export const linkPreviewsApi = {
  async getForMessage(workspaceId: string, messageId: string): Promise<LinkPreviewWithDismissed[]> {
    const key = `${workspaceId}:${messageId}`
    const existing = inFlightMessagePreviewRequests.get(key)
    if (existing) return existing

    const request = api
      .get<{ previews: LinkPreviewWithDismissed[] }>(
        `/api/workspaces/${workspaceId}/messages/${messageId}/link-previews`
      )
      .then((res) => res.previews)
      .finally(() => {
        inFlightMessagePreviewRequests.delete(key)
      })

    inFlightMessagePreviewRequests.set(key, request)
    return request
  },

  async dismiss(workspaceId: string, messageId: string, linkPreviewId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/messages/${messageId}/link-previews/${linkPreviewId}/dismiss`)
    inFlightMessagePreviewRequests.delete(`${workspaceId}:${messageId}`)
    inFlightResolvedInAppLinkRequests.delete(`${workspaceId}:${linkPreviewId}`)
  },

  async resolveInAppLink(workspaceId: string, linkPreviewId: string): Promise<InAppLinkPreviewData> {
    const key = `${workspaceId}:${linkPreviewId}`
    const existing = inFlightResolvedInAppLinkRequests.get(key)
    if (existing) return existing

    const request = api
      .get<InAppLinkPreviewData>(`/api/workspaces/${workspaceId}/link-previews/${linkPreviewId}/resolve`)
      .finally(() => {
        inFlightResolvedInAppLinkRequests.delete(key)
      })

    inFlightResolvedInAppLinkRequests.set(key, request)
    return request
  },

  /**
   * Resolve an in-app link straight from its URL (no persisted preview row),
   * for the composer rendering a draft as you type. Returns the same
   * per-viewer, access-tiered data as {@link resolveInAppLink}.
   */
  async resolveInAppLinkByUrl(workspaceId: string, url: string): Promise<InAppLinkPreviewData> {
    const key = `${workspaceId}:${url}`
    const existing = inFlightResolvedInAppUrlRequests.get(key)
    if (existing) return existing

    const request = api
      .get<InAppLinkPreviewData>(`/api/workspaces/${workspaceId}/link-previews/resolve?url=${encodeURIComponent(url)}`)
      .finally(() => {
        inFlightResolvedInAppUrlRequests.delete(key)
      })

    inFlightResolvedInAppUrlRequests.set(key, request)
    return request
  },
}
