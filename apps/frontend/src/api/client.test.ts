import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACCOUNT_ASSERTION_HEADER, AuthErrorCodes } from "@threahq/types"
import { api, ApiError, isAccountMismatchError, isPermanentApiError, parseApiError, postMultipartFile } from "./client"
import { setAssertedAccount, subscribeAccountMismatch } from "./account-assertion"
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

describe("apiFetch body lifetime", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function heldBody(status: number) {
    let signal: AbortSignal
    let streamController: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })
    const response = new Response(stream, { status })
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      signal = init!.signal!
      const abort = () => streamController.error(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
      return response
    })
    return { response, signal: () => signal }
  }

  it.each([200, 401, 500])("should abort a held %s body when the caller cancels after headers", async (status) => {
    const events: RecordedEvent[] = []
    captureConnectivityEvents(events)
    const transport = heldBody(status)
    const caller = new AbortController()
    const request = api.get("/anything", { signal: caller.signal }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.response.bodyUsed).toBe(true)
    caller.abort()
    expect(transport.signal().aborted).toBe(true)
    const error = await request
    expect(error).toBe(transport.signal().reason)
    expect(error).toMatchObject({ name: "AbortError" })
    expect(ApiError.isApiError(error)).toBe(false)
    expect(events.map(({ event }) => event)).toEqual(["http_start", "http_abort"])
  })

  it.each([200, 401])("should time out a held %s body without producing an auth error", async (status) => {
    const events: RecordedEvent[] = []
    captureConnectivityEvents(events)
    const transport = heldBody(status)
    const request = api.get("/anything", { timeoutMs: 50 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(49)
    expect(transport.signal().aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await request
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: "Request timed out after 50ms" })
    expect(ApiError.isApiError(error)).toBe(false)
    expect(transport.signal().aborted).toBe(true)
    expect(events.map(({ event }) => event)).toEqual(["http_start", "http_stalled", "http_timeout"])
  })

  it.each([200, 204])("should clean up cancellation and timeout after a completed %s response", async (status) => {
    let signal: AbortSignal | null | undefined
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      signal = init?.signal
      return new Response(status === 204 ? null : "{}", { status })
    })
    const caller = new AbortController()
    const remove = vi.spyOn(caller.signal, "removeEventListener")
    await expect(api.get("/anything", { signal: caller.signal, timeoutMs: 50 })).resolves.toEqual(
      status === 204 ? undefined : {}
    )
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function))
    caller.abort()
    await vi.advanceTimersByTimeAsync(50)
    expect(signal?.aborted).toBe(false)
  })

  it("should preserve pre-aborted caller cancellation", async () => {
    const transport = heldBody(200)
    const caller = new AbortController()
    caller.abort()
    await expect(api.get("/anything", { signal: caller.signal })).rejects.toBe(transport.signal().reason)
    expect(transport.signal().aborted).toBe(true)
  })

  it("should classify header failures as network failures and clean up", async () => {
    const events: RecordedEvent[] = []
    captureConnectivityEvents(events)
    const error = new TypeError("Failed to fetch")
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(error)
    const caller = new AbortController()
    const remove = vi.spyOn(caller.signal, "removeEventListener")
    await expect(api.get("/anything", { signal: caller.signal })).rejects.toBe(error)
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function))
    expect(events.map(({ event, fields }) => ({ event, reason: fields.reason }))).toEqual([
      { event: "http_start", reason: undefined },
      { event: "http_failure", reason: "network" },
    ])
    await vi.advanceTimersByTimeAsync(20000)
    expect(events.map(({ event }) => event)).toEqual(["http_start", "http_failure"])
  })

  it("should preserve a real server 401 and malformed successful JSON", async () => {
    const events: RecordedEvent[] = []
    captureConnectivityEvents(events)
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse(401, { error: "Unauthorized", code: "UNAUTHORIZED" }))
      .mockResolvedValueOnce(new Response("not json"))
    await expect(api.get("/anything")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    })
    await expect(api.get("/anything")).rejects.toMatchObject({
      status: 200,
      code: "PARSE_ERROR",
      message: "Failed to parse server response",
    })
    await vi.advanceTimersByTimeAsync(20000)
    expect(events.map(({ event, fields }) => ({ event, reason: fields.reason }))).toEqual([
      { event: "http_start", reason: undefined },
      { event: "http_failure", reason: "server" },
      { event: "http_start", reason: undefined },
      { event: "http_failure", reason: "unknown" },
    ])
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

  it("should record phase detail only once a request is slow", async () => {
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
    await vi.advanceTimersByTimeAsync(diagnostics.SLOW_REQUEST_MS)
    finishBody?.({ ok: true })

    await expect(request).resolves.toEqual({ ok: true })
    expect(events.map((entry) => entry.event)).toEqual(["http_start", "http_stalled", "http_body_complete"])
    expect(events.find((entry) => entry.event === "http_body_complete")?.fields).toEqual({
      method: "GET",
      route: "streams",
      transport: "fetch",
      operationId: "op_test",
      status: 200,
      correlationId: "railway_1",
    })
  })

  it("should keep fast requests to a single start event", async () => {
    const events: RecordedEvent[] = []
    captureConnectivityEvents(events)
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "x-railway-request-id": "railway_fast" },
      })
    ) as unknown as typeof fetch

    await expect(api.get("/api/workspaces/ws/streams")).resolves.toEqual({ ok: true })
    expect(events).toEqual([
      {
        event: "http_start",
        fields: { method: "GET", route: "streams", transport: "fetch", operationId: "op_test" },
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

describe("account assertion", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  afterEach(() => {
    setAssertedAccount(null)
    globalThis.fetch = originalFetch
  })

  it("should state the account a request was formed for when one is active", async () => {
    setAssertedAccount("usr_a")
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { ok: true }))

    await api.get("/anything")

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)[ACCOUNT_ASSERTION_HEADER]).toBe("usr_a")
  })

  it("should send no assertion before an account resolves", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { ok: true }))

    await api.get("/anything")

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit
    expect(init.headers as Record<string, string>).not.toHaveProperty(ACCOUNT_ASSERTION_HEADER)
  })

  it("should assert the account on a multipart upload too", async () => {
    setAssertedAccount("usr_a")
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { ok: true }))

    await postMultipartFile("/upload", new File(["x"], "x.txt"), "file")

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)[ACCOUNT_ASSERTION_HEADER]).toBe("usr_a")
  })

  it("should treat a refused account as pausable, not as a permanent verdict on the payload", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(409, {
        error: "This browser is signed in as a different account",
        code: AuthErrorCodes.ACCOUNT_MISMATCH,
      })
    )

    const err = (await api.post("/messages", {}).catch((e) => e)) as ApiError
    expect(isAccountMismatchError(err)).toBe(true)
    // Queues reconcile permanent rejections away — a mismatch must survive.
    expect(isPermanentApiError(err)).toBe(false)
  })

  it("should keep an ordinary 409 permanent so queues still reconcile it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(409, { error: "Conflict", code: "STALE_VERSION" }))

    const err = (await api.post("/messages", {}).catch((e) => e)) as ApiError
    expect(isAccountMismatchError(err)).toBe(false)
    expect(isPermanentApiError(err)).toBe(true)
  })

  it("should tell the identity owner to revalidate when the server names another account", async () => {
    const seen: string[] = []
    const unsubscribe = subscribeAccountMismatch(() => seen.push("mismatch"))
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(409, { error: "nope", code: AuthErrorCodes.ACCOUNT_MISMATCH })
    )

    await api.get("/anything").catch(() => {})
    unsubscribe()

    expect(seen).toEqual(["mismatch"])
  })
})
