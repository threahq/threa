// Minimal API client for the backoffice. Mirrors the main frontend's shape so
// the two stay familiar, but without the offline / service-worker paths.

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
 * Formats an unknown error (typically `useMutation`'s `error`) into a string
 * suitable for an inline banner. Returns null for the no-error case so callers
 * can short-circuit conditional rendering.
 */
export function readApiError(error: unknown): string | null {
  if (!error) return null
  if (ApiError.isApiError(error)) return error.message
  return "Something went wrong"
}

/**
 * Base URL for API calls. Empty string = same-origin, which is what we use
 * both in dev (vite proxy → control-plane) and in prod (CF Worker proxy →
 * control-plane). A full origin can be supplied via VITE_API_BASE_URL for
 * environments where same-origin isn't an option.
 */
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ""

interface ErrorBody {
  error?: string
  code?: string
  details?: Record<string, unknown>
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  })

  if (response.status === 204) {
    return undefined as T
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(response.status, "PARSE_ERROR", "Failed to parse server response")
  }

  if (!response.ok) {
    const err = body as ErrorBody
    throw new ApiError(
      response.status,
      err.code ?? "UNKNOWN_ERROR",
      err.error ?? `Request failed with status ${response.status}`,
      err.details
    )
  }

  return body as T
}

export const api = {
  get<T>(path: string, options?: RequestInit): Promise<T> {
    return apiFetch<T>(path, { ...options, method: "GET" })
  },

  post<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return apiFetch<T>(path, {
      ...options,
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    })
  },

  put<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return apiFetch<T>(path, {
      ...options,
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    })
  },

  delete<T>(path: string, options?: RequestInit): Promise<T> {
    return apiFetch<T>(path, { ...options, method: "DELETE" })
  },
}
