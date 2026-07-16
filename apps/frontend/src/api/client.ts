import {
  AUTH_SESSION_INVALID_CODE,
  AUTH_TOKEN_EXPIRED_CODE,
  THREA_AUTH_MODE_CLIENT_REFRESH,
  THREA_AUTH_MODE_HEADER,
} from "@threa/types"

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
 * Base URL for API calls. Empty string for same-origin (dev/prod),
 * absolute URL for staging (e.g. "https://staging.threa.io").
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
export async function postMultipartFile<T>(
  path: string,
  file: File,
  fieldName: string,
  fallback: { code?: string; message?: string } = {}
): Promise<T> {
  const post = async (): Promise<Response> => {
    // Fresh FormData per attempt: a File re-reads fine, but a consumed
    // FormData body is not guaranteed re-sendable everywhere.
    const formData = new FormData()
    formData.append(fieldName, file)
    return fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { [THREA_AUTH_MODE_HEADER]: THREA_AUTH_MODE_CLIENT_REFRESH },
      body: formData,
    })
  }
  let response = await post()
  if (!response.ok) {
    const error = await parseApiError(response, fallback)
    if (error.status !== 401 || error.code !== AUTH_TOKEN_EXPIRED_CODE) throw error
    // Same refresh-once-and-retry as apiFetch (see ensureFreshSession).
    const outcome = await ensureFreshSession()
    if (outcome === "session-dead") throw error
    if (outcome === "unavailable") throw new Error("Session refresh unavailable; upload not retried")
    response = await post()
    if (!response.ok) throw await parseApiError(response, fallback)
  }
  return (await response.json()) as T
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

// --- Client-coordinated session refresh -------------------------------------
//
// Every request opts into verify-only auth (THREA_AUTH_MODE_HEADER): the
// server never refreshes the WorkOS session inline, so an expired access
// token 401s fast with TOKEN_EXPIRED. This layer then runs EXACTLY ONE
// refresh — deduped across concurrent queries by a shared promise and across
// tabs by a Web Lock — and retries the failed request once. WorkOS rotates
// refresh tokens on use, so two concurrent refreshes with the same cookie
// invalidate each other (the random-logout generator this replaces); the
// browser is the natural singleton for its session, which makes this correct
// on any number of backend replicas, regions, or services.

const REFRESH_LOCK_NAME = "threa-session-refresh"

/** Outcome of a coordinated refresh attempt. */
type RefreshOutcome = "refreshed" | "session-dead" | "unavailable"

let refreshInflight: Promise<RefreshOutcome> | null = null

async function requestRefresh(): Promise<RefreshOutcome> {
  // Deliberately WITHOUT the auth-mode header: the refresh endpoint mounts the
  // legacy implicit-refresh middleware, which rotates the cookie onto this
  // response. A still-valid token (another tab refreshed first while we waited
  // on the lock) is a no-op 200 — no redundant rotation.
  let response: Response
  try {
    response = await fetch(`${API_BASE}/api/auth/refresh`, { method: "POST", credentials: "include" })
  } catch {
    return "unavailable"
  }
  if (response.ok) return "refreshed"
  if (response.status !== 401) return "unavailable"
  const body = (await response.json().catch(() => ({}))) as ErrorResponse
  // AUTH_UNAVAILABLE (WorkOS outage / refresh race) is transient: the session
  // may be fine — do not treat it as dead.
  return body.code === AUTH_SESSION_INVALID_CODE ? "session-dead" : "unavailable"
}

/**
 * Run one coordinated session refresh. Callers that hit TOKEN_EXPIRED await
 * this and retry once; all concurrent callers (and other tabs, via the Web
 * Lock) share a single WorkOS refresh.
 */
export function ensureFreshSession(): Promise<RefreshOutcome> {
  if (refreshInflight) return refreshInflight
  // Web Locks serialize refreshes across tabs; a tab that waited here very
  // likely finds a fresh cookie and its refresh call no-ops server-side.
  // Older browsers without the API fall back to in-tab dedupe only.
  const run = async (): Promise<RefreshOutcome> =>
    typeof navigator !== "undefined" && navigator.locks
      ? ((await navigator.locks.request(REFRESH_LOCK_NAME, requestRefresh)) as RefreshOutcome)
      : requestRefresh()
  refreshInflight = run().finally(() => {
    refreshInflight = null
  })
  return refreshInflight
}

export type ApiRequestInit = RequestInit & { timeoutMs?: number }

async function apiFetch<T>(path: string, options: ApiRequestInit = {}): Promise<T> {
  try {
    return await apiFetchOnce<T>(path, options)
  } catch (error) {
    // Expired access token: refresh once (coordinated across queries + tabs)
    // and retry once. Any other outcome — session dead, refresh unavailable,
    // retry failing again — falls through to the normal error paths.
    if (!(error instanceof ApiError) || error.status !== 401 || error.code !== AUTH_TOKEN_EXPIRED_CODE) {
      throw error
    }
    if (options.signal?.aborted) throw error
    const outcome = await ensureFreshSession()
    if (outcome === "session-dead") throw error
    if (outcome === "unavailable") {
      // A plain Error (not ApiError) so handleGlobalError can't read it as a
      // 401 and bounce to login while auth is merely unreachable — queries
      // settle to cached/IDB state, same as the timeout path.
      throw new Error("Session refresh unavailable; request not retried")
    }
    return await apiFetchOnce<T>(path, options)
  }
}

async function apiFetchOnce<T>(path: string, options: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...init } = options

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
        [THREA_AUTH_MODE_HEADER]: THREA_AUTH_MODE_CLIENT_REFRESH,
        ...init.headers,
      },
    })
  } catch (err) {
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

  if (response.status === 204) {
    return undefined as T
  }

  if (!response.ok) {
    throw await parseApiError(response)
  }

  // A malformed success payload (server lied about content-type) is a distinct
  // failure mode from an error response, so it gets its own code.
  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError(response.status, "PARSE_ERROR", "Failed to parse server response")
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
