import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
