/**
 * Multipart upload over XMLHttpRequest. `fetch` still has no upload-progress
 * events, so the upload manager's progress reporting rides XHR's
 * `upload.onprogress`. No timeout — large files on slow links legitimately
 * take minutes; the caller owns cancellation via `signal`.
 */

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

    const xhr = new XMLHttpRequest()
    xhr.open("POST", url)
    xhr.withCredentials = true
    // No Content-Type header — the browser sets it with the multipart boundary.

    const onAbort = () => xhr.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    const cleanup = () => signal?.removeEventListener("abort", onAbort)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
    }
    xhr.onload = () => {
      cleanup()
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // Non-JSON body (proxy error page) — status alone drives handling.
      }
      resolve({ status: xhr.status, body })
    }
    xhr.onerror = () => {
      cleanup()
      reject(new XhrNetworkError())
    }
    xhr.onabort = () => {
      cleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }

    xhr.send(formData)
  })
}
