import {
  beginConnectivityObservation,
  categorizeRoute,
  flushConnectivityDiagnostics,
  SLOW_REQUEST_MS,
} from "@/lib/connectivity-diagnostics/facade"

/**
 * Multipart upload over XMLHttpRequest. `fetch` still has no upload-progress
 * events, so the upload manager's progress reporting rides XHR's
 * `upload.onprogress`. No timeout — large files on slow links legitimately
 * take minutes; the caller owns cancellation via `signal`.
 */

import { accountAssertionHeaders } from "@/api/account-assertion"

export interface XhrUploadParams {
  url: string
  /** The upload payload (original file, or ciphertext for E2E). */
  blob: Blob
  filename: string
  /** Extra multipart fields, appended before the file part. */
  fields?: Record<string, string>
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

export interface XhrUploadResponse {
  status: number
  body: unknown
}

/** Network-level failure (connection dropped, DNS, offline) — retryable. */
export class XhrNetworkError extends Error {
  constructor() {
    super("Network error during upload")
    this.name = "XhrNetworkError"
  }
}

export function xhrUpload({
  url,
  blob,
  filename,
  fields,
  signal,
  onProgress,
}: XhrUploadParams): Promise<XhrUploadResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }

    const formData = new FormData()
    for (const [name, value] of Object.entries(fields ?? {})) formData.append(name, value)
    formData.append("file", blob, filename)

    const observation = beginConnectivityObservation({ method: "POST", route: categorizeRoute(url), transport: "xhr" })
    observation.record("http_start")
    const startedAt = performance.now()
    // Phase detail (headers/body) is only evidence for slow requests; fast ones
    // would triple telemetry volume without improving diagnosis.
    const isSlow = () => performance.now() - startedAt >= SLOW_REQUEST_MS
    const stopStallTimer = observation.stall()
    let uploadComplete = false

    const xhr = new XMLHttpRequest()
    xhr.open("POST", url)
    xhr.withCredentials = true
    // No Content-Type header — the browser sets it with the multipart boundary.
    // The account this transfer was formed for rides along as it does on `apiFetch`:
    // the cookie alone can't say which signed-in account is streaming these bytes.
    for (const [name, value] of Object.entries(accountAssertionHeaders())) xhr.setRequestHeader(name, value)

    const onAbort = () => xhr.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    const cleanup = () => {
      stopStallTimer()
      signal?.removeEventListener("abort", onAbort)
    }
    const markUploadComplete = () => {
      if (uploadComplete) return
      uploadComplete = true
      observation.record("http_upload_complete")
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(event.loaded / event.total)
        if (event.loaded >= event.total) markUploadComplete()
      }
    }
    xhr.upload.onload = markUploadComplete
    let responseFields: { status: number; correlationId?: string } = { status: 0 }
    let headersRecorded = false
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.HEADERS_RECEIVED || headersRecorded) return
      headersRecorded = true
      responseFields = { status: xhr.status, correlationId: xhr.getResponseHeader("x-railway-request-id") ?? undefined }
      if (isSlow()) observation.record("http_headers", responseFields)
    }
    xhr.onload = () => {
      cleanup()
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // Non-JSON body (proxy error page) — status alone drives handling.
      }
      if (isSlow()) observation.record("http_body_complete", responseFields)
      if (xhr.status < 200 || xhr.status >= 300) {
        observation.record("http_failure", { ...responseFields, reason: "server" })
        void flushConnectivityDiagnostics()
      }
      resolve({ status: xhr.status, body })
    }
    xhr.onerror = () => {
      cleanup()
      observation.record("http_failure", { reason: "network" })
      void flushConnectivityDiagnostics()
      reject(new XhrNetworkError())
    }
    xhr.onabort = () => {
      cleanup()
      observation.record("http_abort", { reason: "abort" })
      reject(new DOMException("Aborted", "AbortError"))
    }

    xhr.send(formData)
  })
}
