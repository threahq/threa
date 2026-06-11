import { api, API_BASE, ApiError, parseApiError } from "./client"
import type { Attachment, AttachmentCategory } from "@threa/types"

export interface AttachmentSearchExtractionExcerpt {
  contentType: string
  summary: string
}

export interface AttachmentExtractionContent {
  contentType: string
  summary: string
  fullText: string | null
}

export interface AttachmentSearchItem extends Attachment {
  extraction: AttachmentSearchExtractionExcerpt | null
  streamSlug: string | null
  streamName: string | null
  streamType: string | null
  uploaderSlug: string | null
  uploaderName: string | null
  referenceCount: number
}

export interface AttachmentSearchRequest {
  streamIds?: string[]
  categories?: AttachmentCategory[]
  uploadedBy?: string
  before?: string
  after?: string
  queryText?: string
  exact?: boolean
  nameSubstring?: string
  cursor?: string
  limit?: number
}

export interface AttachmentSearchResponse {
  items: AttachmentSearchItem[]
  nextCursor: string | null
}

const inFlightDownloadUrlRequests = new Map<string, Promise<string>>()
const resolvedDownloadUrlCache = new Map<string, { url: string; expiresAt: number }>()

export function resetAttachmentUrlCache(): void {
  inFlightDownloadUrlRequests.clear()
  resolvedDownloadUrlCache.clear()
}

/**
 * Synchronous peek at an already-resolved download URL. Lets remounting
 * components (virtualized rows) seed their initial state with the cached URL
 * instead of rendering a skeleton for the frame(s) the async `getDownloadUrl`
 * resolution takes, even on a warm cache.
 */
export function peekDownloadUrl(
  workspaceId: string,
  attachmentId: string,
  options?: { download?: boolean; variant?: "raw" | "processed" | "thumbnail" }
): string | null {
  const key = `${workspaceId}:${attachmentId}:${options?.download ? "download" : "inline"}:${options?.variant ?? "raw"}`
  const cached = resolvedDownloadUrlCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  return null
}

export const attachmentsApi = {
  /**
   * Upload a file to the workspace.
   * File is uploaded to workspace-level; streamId is set when attached to a message.
   * Uses multipart form data instead of JSON.
   */
  async upload(workspaceId: string, file: File, options?: { e2e?: boolean }): Promise<Attachment> {
    const formData = new FormData()
    formData.append("file", file)
    // E2E: `file` is already client-side ciphertext. The flag tells the server
    // to store it opaquely — skip scanning/processing and keep no real
    // filename/mime (the real metadata rides in the message's attachmentRefs).
    if (options?.e2e) formData.append("e2e", "true")

    const response = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/attachments`, {
      method: "POST",
      body: formData,
      credentials: "include",
      // Note: Don't set Content-Type header - browser sets it with boundary
    })

    if (!response.ok) {
      throw await parseApiError(response, { code: "UPLOAD_ERROR", message: "Upload failed" })
    }

    const body = await response.json()
    if (!body.attachment) {
      throw new ApiError(500, "INVALID_RESPONSE", "Server returned invalid response")
    }
    return body.attachment
  },

  /**
   * Get a presigned download URL for an attachment.
   * URL is valid for 15 minutes.
   */
  async getDownloadUrl(
    workspaceId: string,
    attachmentId: string,
    options?: { download?: boolean; variant?: "raw" | "processed" | "thumbnail" }
  ): Promise<string> {
    const key = `${workspaceId}:${attachmentId}:${options?.download ? "download" : "inline"}:${options?.variant ?? "raw"}`
    const cached = resolvedDownloadUrlCache.get(key)
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.url
      }
      resolvedDownloadUrlCache.delete(key)
    }

    const existing = inFlightDownloadUrlRequests.get(key)
    if (existing) return existing

    const searchParams = new URLSearchParams()
    if (options?.download) searchParams.set("download", "true")
    if (options?.variant) searchParams.set("variant", options.variant)
    const params = searchParams.toString() ? `?${searchParams.toString()}` : ""
    const request = api
      .get<{ url: string; expiresIn: number }>(
        `/api/workspaces/${workspaceId}/attachments/${attachmentId}/url${params}`
      )
      .then((res) => {
        resolvedDownloadUrlCache.set(key, {
          url: res.url,
          expiresAt: Date.now() + Math.max(0, res.expiresIn * 1000 - 5_000),
        })
        return res.url
      })
      .finally(() => {
        inFlightDownloadUrlRequests.delete(key)
      })

    inFlightDownloadUrlRequests.set(key, request)
    return request
  },

  /**
   * Delete an unattached file.
   * Attached files cannot be deleted.
   */
  delete(workspaceId: string, attachmentId: string): Promise<void> {
    return api.delete(`/api/workspaces/${workspaceId}/attachments/${attachmentId}`)
  },

  /**
   * Search attachments for the explorer modal. Server-side gates results to
   * streams the caller can read, expands threads into their root scope when
   * `streamIds` is set, and applies category/date/free-text filters with
   * keyset cursor pagination.
   */
  search(workspaceId: string, body: AttachmentSearchRequest): Promise<AttachmentSearchResponse> {
    return api.post<AttachmentSearchResponse>(`/api/workspaces/${workspaceId}/attachments/search`, body)
  },

  /**
   * Fetch the full extracted text for an attachment. Used by the explorer
   * preview pane when the user expands the truncated summary or copies the
   * full content.
   */
  getExtraction(workspaceId: string, attachmentId: string): Promise<AttachmentExtractionContent> {
    return api.get<AttachmentExtractionContent>(`/api/workspaces/${workspaceId}/attachments/${attachmentId}/extraction`)
  },
}
