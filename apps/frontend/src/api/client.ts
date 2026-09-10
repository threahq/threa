import {
  beginConnectivityObservation,
  categorizeRoute,
  flushConnectivityDiagnostics,
} from "@/lib/connectivity-diagnostics/facade"

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = "ApiError"
  }

  static isApiError(error: unknown): error is ApiError {
    return error instanceof ApiError
  }
}

/**
 * A 4xx verdict the server will keep returning no matter how many times the
 * same request is replayed (excluding 408 timeout and 429 rate-limit, which
 * are transient). Offline-replay and retry paths must treat these as
 * terminal: drop the operation and reconcile local state to the server's
 * answer instead of retrying.
 */
export function isPermanentApiError(error: unknown): error is ApiError {
  return (
    ApiError.isApiError(error) &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  )
}

// Canonical error shape emitted by the backend's `errorHandler` middleware
// (packages/backend-common/src/middleware/error-handler.ts) and matched by
// inline handler responses: `{ error: "<message>", code?: "<CODE>" }`.
interface ErrorResponse {
  error?: string
  code?: string
  details?: Record<string, unknown>
}

/**
 * Read an error response and return a typed `ApiError`. Use this from
 * raw `fetch` callers (multipart uploads) so they share `apiFetch`'s
 * error-shape handling instead of reimplementing it. A body that's
 * missing or unparseable falls back to the supplied defaults rather
 * than crashing.
 */
export async function parseApiError(
  response: Response,
  fallback: { code?: string; message?: string } = {}
): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as ErrorResponse
  const code = body.code || fallback.code || "UNKNOWN_ERROR"
  const message = body.error || fallback.message || `Request failed with status ${response.status}`
  return new ApiError(response.status, code, message, body.details)
}

/**
 * Base URL for API calls. Empty string for same-origin deployments; an
 * absolute override supports remote development targets.
 */
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ""

/**
 * Multipart single-file upload. The shared `apiFetch` forces a JSON content-type,
 * which would clobber the multipart boundary the browser must set for a
 * `FormData` body — so this posts the form directly and returns the parsed JSON
 * for the caller to project onto its own response shape. `fieldName` is the
 * multer field the endpoint reads (`avatar` for avatars, `file` for persona
 * knowledge attachments).
 */
export async function requestMultipart<T>(
  path: string,
  formData: FormData,
  fallback: { code?: string; message?: string } = {}
): Promise<T> {
  const observation = beginConnectivityObservation({ method: "POST", route: categorizeRoute(path), transport: "fetch" })
  observation.record("http_start")
  const stopStallTimer = observation.stall()
  let responseFields: { status: number; correlationId?: string } | null = null
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      body: formData,
    })
    const correlationId = response.headers.get("x-railway-request-id") ?? undefined
    responseFields = { status: response.status, correlationId }
    observation.record("http_headers", responseFields)
    if (!response.ok) {
      const error = await parseApiError(response, fallback)
      observation.record("http_body_complete", responseFields)
      observation.record("http_failure", { ...responseFields, reason: "server" })
      void flushConnectivityDiagnostics()
      throw error
    }
    const body = (await response.json()) as T
    observation.record("http_body_complete", responseFields)
    return body
  } catch (error) {
    if (!ApiError.isApiError(error)) {
      observation.record(
        "http_failure",
        responseFields ? { ...responseFields, reason: "unknown" } : { reason: "network" }
      )
      void flushConnectivityDiagnostics()
    }
    throw error
  } finally {
    stopStallTimer()
  }
}

export function postMultipartFile<T>(
  path: string,
  file: File,
  fieldName: string,
  fallback: { code?: string; message?: string } = {}
): Promise<T> {
  const formData = new FormData()
  formData.append(fieldName, file)
  return requestMultipart<T>(path, formData, fallback)
}

/** Multipart avatar upload (bots and personas) — the `avatar`-field specialization. */
export function postAvatarUpload<T>(path: string, file: File): Promise<T> {
  return postMultipartFile<T>(path, file, "avatar", {
    code: "AVATAR_UPLOAD_ERROR",
    message: "Failed to upload avatar",
  })
}

// Bound every request so a flaky/slow network can't leave a fetch hanging
// forever — background revalidations must settle (to cached state) instead of
// piling up. Generous because it's a safety net, not a latency budget;
// override per-call via `options.timeoutMs`.
const DEFAULT_TIMEOUT_MS = 20000

export type ApiRequestInit = RequestInit & { timeoutMs?: number }

async function apiFetch<T>(path: string, options: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...init } = options
  const method = (init.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  const observation = beginConnectivityObservation({ method, route: categorizeRoute(path), transport: "fetch" })
  observation.record("http_start")
  const stopStallTimer = observation.stall()

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onCallerAbort = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true })
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    })
  } catch (err) {
    stopStallTimer()
    let diagnosticEvent: "http_timeout" | "http_abort" | "http_failure" = "http_failure"
    let diagnosticReason: "timeout" | "abort" | "network" = "network"
    if (timedOut) {
      diagnosticEvent = "http_timeout"
      diagnosticReason = "timeout"
    } else if (controller.signal.aborted) {
      diagnosticEvent = "http_abort"
      diagnosticReason = "abort"
    }
    observation.record(diagnosticEvent, { reason: diagnosticReason })
    void flushConnectivityDiagnostics()
    // A timeout is a network-like failure, not an auth signal. Throw a plain
    // Error (NOT an ApiError) so `handleGlobalError` can't mistake it for a
    // 401 and bounce the user to login — queries fall back to cached/IDB
    // state instead. A caller-driven abort rethrows unchanged.
    if (timedOut) {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort)
  }

  const correlationId = response.headers.get("x-railway-request-id") ?? undefined
  const responseFields = { status: response.status, correlationId }
  observation.record("http_headers", responseFields)
  if (response.status === 204) {
    stopStallTimer()
    observation.record("http_body_complete", responseFields)
    return undefined as T
  }

  if (!response.ok) {
    try {
      const error = await parseApiError(response)
      observation.record("http_body_complete", responseFields)
      observation.record("http_failure", { ...responseFields, reason: "server" })
      void flushConnectivityDiagnostics()
      throw error
    } finally {
      stopStallTimer()
    }
  }

  try {
    const body = (await response.json()) as T
    observation.record("http_body_complete", responseFields)
    return body
  } catch {
    observation.record("http_failure", { ...responseFields, reason: "unknown" })
    void flushConnectivityDiagnostics()
    throw new ApiError(response.status, "PARSE_ERROR", "Failed to parse server response")
  } finally {
    stopStallTimer()
  }
}

export const api = {
  get<T>(path: string, options?: ApiRequestInit): Promise<T> {
    return apiFetch<T>(path, { ...options, method: "GET" })
  },

  post<T>(path: string, body?: unknown, options?: ApiRequestInit): Promise<T> {
    return apiFetch<T>(path, {
      ...options,
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    })
  },

  patch<T>(path: string, body?: unknown, options?: ApiRequestInit): Promise<T> {
    return apiFetch<T>(path, {
      ...options,
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    })
  },

  put<T>(path: string, body?: unknown, options?: ApiRequestInit): Promise<T> {
    return apiFetch<T>(path, {
      ...options,
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    })
  },

  delete<T>(path: string, options?: ApiRequestInit): Promise<T> {
    return apiFetch<T>(path, { ...options, method: "DELETE" })
  },
}

export default api
