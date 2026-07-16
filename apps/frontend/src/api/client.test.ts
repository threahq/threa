import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { THREA_AUTH_MODE_HEADER } from "@threa/types"
import { api, ApiError, parseApiError } from "./client"

const originalFetch = globalThis.fetch

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("apiFetch error parsing", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("hydrates ApiError from the canonical { error, code } shape emitted by the backend's errorHandler", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(503, { error: "Push notifications are not enabled", code: "PUSH_DISABLED" })
    )

    const err = (await api.get("/anything").catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      status: 503,
      code: "PUSH_DISABLED",
      message: "Push notifications are not enabled",
    })
  })

  it("falls back to a generic message when the body is missing fields", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500, {}))
    const err = (await api.get("/anything").catch((e) => e)) as ApiError
    expect(err).toMatchObject({
      status: 500,
      code: "UNKNOWN_ERROR",
      message: "Request failed with status 500",
    })
  })

  it("captures details when the handler ships them alongside error/code", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(400, {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: { fieldErrors: { endpoint: ["Required"] } },
      })
    )

    const err = (await api.get("/anything").catch((e) => e)) as ApiError
    expect(err).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      details: { fieldErrors: { endpoint: ["Required"] } },
    })
  })
})

describe("apiFetch request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Never settles on its own — only the AbortController timeout ends it.
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it("aborts a hung request as a non-ApiError so it is not mistaken for a 401 redirect", async () => {
    const p = api.get("/slow", { timeoutMs: 50 }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(50)
    const err = (await p) as Error

    expect(err).toBeInstanceOf(Error)
    expect(ApiError.isApiError(err)).toBe(false)
    expect(err.message).toBe("Request timed out after 50ms")
  })

  it("does not abort before the timeout elapses", async () => {
    const p = api.get("/slow", { timeoutMs: 1000 }).catch((e) => e)
    let settled = false
    void p.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(((await p) as Error).message).toBe("Request timed out after 1000ms")
  })
})

describe("apiFetch client-coordinated session refresh", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const expired = () => mockResponse(401, { error: "Session expired", code: "TOKEN_EXPIRED" })
  const ok = (body: unknown) => mockResponse(200, body)

  function fetchCalls(): Array<{ url: string; init: RequestInit | undefined }> {
    return vi.mocked(globalThis.fetch).mock.calls.map(([url, init]) => ({ url: String(url), init }))
  }

  it("sends the auth-mode header on every request", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(ok({ fine: true }))
    await api.get("/anything")
    const headers = fetchCalls()[0]!.init?.headers as Record<string, string>
    expect(headers[THREA_AUTH_MODE_HEADER]).toBe("client-refresh")
  })

  it("on TOKEN_EXPIRED: refreshes once (without the header) and retries the request once", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(expired()) // original request
      .mockResolvedValueOnce(ok({ data: { ok: true } })) // POST /api/auth/refresh
      .mockResolvedValueOnce(ok({ answer: 42 })) // retried request

    const result = await api.get<{ answer: number }>("/data")

    expect(result).toEqual({ answer: 42 })
    const calls = fetchCalls()
    expect(calls.map((c) => c.url)).toEqual(["/data", "/api/auth/refresh", "/data"])
    // The refresh call must take the LEGACY implicit-refresh path — no auth-mode header.
    const refreshHeaders = (calls[1]!.init?.headers ?? {}) as Record<string, string>
    expect(refreshHeaders[THREA_AUTH_MODE_HEADER]).toBeUndefined()
  })

  it("coalesces concurrent TOKEN_EXPIRED failures into ONE refresh", async () => {
    let refreshCount = 0
    vi.mocked(globalThis.fetch).mockImplementation(async (url: RequestInfo | URL) => {
      const path = String(url)
      if (path === "/api/auth/refresh") {
        refreshCount++
        // Yield so both callers are queued on the shared promise before it settles.
        await new Promise((r) => setTimeout(r, 10))
        return ok({ data: { ok: true } })
      }
      return refreshCount > 0 ? ok({ path }) : expired()
    })

    const [a, b] = await Promise.all([api.get<{ path: string }>("/a"), api.get<{ path: string }>("/b")])

    expect(refreshCount).toBe(1)
    expect([a.path, b.path]).toEqual(["/a", "/b"])
  })

  it("a dead session (SESSION_INVALID refresh) rethrows the original 401 so the login redirect fires", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(mockResponse(401, { error: "Session expired", code: "SESSION_INVALID" }))

    const err = (await api.get("/data").catch((e) => e)) as ApiError
    expect(ApiError.isApiError(err)).toBe(true)
    expect(err).toMatchObject({ status: 401, code: "TOKEN_EXPIRED" })
    expect(fetchCalls()).toHaveLength(2) // no retry of the original request
  })

  it("an unavailable refresh (outage) throws a NON-ApiError so the app is not bounced to login", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(expired()).mockRejectedValueOnce(new TypeError("Failed to fetch"))

    const err = (await api.get("/data").catch((e) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(ApiError.isApiError(err)).toBe(false)
    expect(err.message).toContain("Session refresh unavailable")
  })

  it("a 401 with a non-expired code (e.g. SESSION_INVALID) is thrown as-is with no refresh attempt", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(401, { error: "Session expired", code: "SESSION_INVALID" })
    )

    const err = (await api.get("/data").catch((e) => e)) as ApiError
    expect(err).toMatchObject({ status: 401, code: "SESSION_INVALID" })
    expect(fetchCalls()).toHaveLength(1)
  })
})

describe("parseApiError — for raw fetch callers (multipart uploads)", () => {
  it("uses the supplied fallback when the body is empty", async () => {
    const response = new Response("", { status: 500, headers: { "Content-Type": "application/json" } })
    const err = await parseApiError(response, { code: "UPLOAD_ERROR", message: "Upload failed" })
    expect(err).toMatchObject({ status: 500, code: "UPLOAD_ERROR", message: "Upload failed" })
  })

  it("prefers the wire-shape over the fallback when the server provided one", async () => {
    const response = new Response(JSON.stringify({ error: "File too large", code: "FILE_TOO_LARGE" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    })
    const err = await parseApiError(response, { code: "UPLOAD_ERROR", message: "Upload failed" })
    expect(err).toMatchObject({ status: 413, code: "FILE_TOO_LARGE", message: "File too large" })
  })
})
