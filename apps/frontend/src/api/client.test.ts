import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api, ApiError, parseApiError, postMultipartFile } from "./client"
import * as diagnostics from "@/lib/connectivity-diagnostics/facade"

const originalFetch = globalThis.fetch

type RecordedEvent = { event: diagnostics.ConnectivityEvent; fields: diagnostics.DiagnosticFields }

function captureConnectivityEvents(events: RecordedEvent[]): void {
  vi.spyOn(diagnostics, "beginConnectivityObservation").mockImplementation((fields = {}) => ({
    id: "op_test",
    record: (event, extra = {}) => {
      events.push({ event, fields: { ...fields, ...extra, operationId: "op_test" } })
    },
    stall: () => {
      const timer = setTimeout(
        () => events.push({ event: "http_stalled", fields: { ...fields, operationId: "op_test" } }),
        10
      )
      return () => clearTimeout(timer)
    },
  }))
}

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

describe("HTTP connectivity phases", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it("should distinguish a response-body stall from waiting for headers", async () => {
    const events: RecordedEvent[] = []
    captureConnectivityEvents(events)
    let finishBody: ((value: unknown) => void) | undefined
    const response = new Response("{}", {
      status: 200,
      headers: { "x-railway-request-id": "railway_1" },
    })
    response.json = () =>
      new Promise((resolve) => {
        finishBody = resolve
      })
    globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch

    const request = api.get("/api/workspaces/ws/streams")
    await vi.advanceTimersByTimeAsync(10)
    finishBody?.({ ok: true })

    await expect(request).resolves.toEqual({ ok: true })
    expect(events).toEqual([
      {
        event: "http_start",
        fields: { method: "GET", route: "streams", transport: "fetch", operationId: "op_test" },
      },
      {
        event: "http_headers",
        fields: {
          method: "GET",
          route: "streams",
          transport: "fetch",
          operationId: "op_test",
          status: 200,
          correlationId: "railway_1",
        },
      },
      {
        event: "http_stalled",
        fields: { method: "GET", route: "streams", transport: "fetch", operationId: "op_test" },
      },
      {
        event: "http_body_complete",
        fields: {
          method: "GET",
          route: "streams",
          transport: "fetch",
          operationId: "op_test",
          status: 200,
          correlationId: "railway_1",
        },
      },
    ])
  })

  it("should instrument multipart fetch without adding a request timeout", async () => {
    const events: RecordedEvent[] = []
    captureConnectivityEvents(events)
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "x-railway-request-id": "railway_2" },
      })
    ) as unknown as typeof fetch

    await expect(
      postMultipartFile("/api/workspaces/ws/profile/avatar", new File(["x"], "x.png"), "avatar")
    ).resolves.toEqual({ ok: true })
    expect(events).toEqual([
      {
        event: "http_start",
        fields: { method: "POST", route: "avatars", transport: "fetch", operationId: "op_test" },
      },
      {
        event: "http_headers",
        fields: {
          method: "POST",
          route: "avatars",
          transport: "fetch",
          operationId: "op_test",
          status: 200,
          correlationId: "railway_2",
        },
      },
      {
        event: "http_body_complete",
        fields: {
          method: "POST",
          route: "avatars",
          transport: "fetch",
          operationId: "op_test",
          status: 200,
          correlationId: "railway_2",
        },
      },
    ])
    expect(vi.mocked(globalThis.fetch).mock.calls[0]![1]).not.toHaveProperty("signal")
  })

  it("should preserve response diagnostics when multipart JSON parsing fails", async () => {
    const events: RecordedEvent[] = []
    captureConnectivityEvents(events)
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "x-railway-request-id": "railway_parse" },
      })
    ) as unknown as typeof fetch

    const error = await postMultipartFile(
      "/api/workspaces/ws/profile/avatar",
      new File(["x"], "x.png"),
      "avatar"
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SyntaxError)
    expect(events).toEqual([
      {
        event: "http_start",
        fields: { method: "POST", route: "avatars", transport: "fetch", operationId: "op_test" },
      },
      {
        event: "http_headers",
        fields: {
          method: "POST",
          route: "avatars",
          transport: "fetch",
          operationId: "op_test",
          status: 200,
          correlationId: "railway_parse",
        },
      },
      {
        event: "http_failure",
        fields: {
          method: "POST",
          route: "avatars",
          transport: "fetch",
          operationId: "op_test",
          status: 200,
          correlationId: "railway_parse",
          reason: "unknown",
        },
      },
    ])
  })
})

describe("parseApiError for raw fetch callers", () => {
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
