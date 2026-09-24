import { describe, expect, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { createRateLimit } from "@threahq/backend-common"
import { createRateLimiters } from "./rate-limit"

interface MockResponse {
  headers: Map<string, string>
  statusCode: number
  body: unknown
}

function createReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: "127.0.0.1",
    headers: {},
    path: "/test",
    ...overrides,
  } as Request
}

function createRes(): Response & MockResponse {
  const headers = new Map<string, string>()
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(name: string, value: string) {
      headers.set(name, value)
      return this
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  } as Response & MockResponse
}

function run(
  middleware: ReturnType<typeof createRateLimit>,
  req: Request,
  res: Response & MockResponse
): { nextCalled: boolean } {
  let nextCalled = false
  const next: NextFunction = () => {
    nextCalled = true
  }
  middleware(req, res, next)
  return { nextCalled }
}

describe("createRateLimit", () => {
  test("allows requests up to the configured limit and then returns 429", () => {
    const limiter = createRateLimit({
      name: "test",
      windowMs: 60_000,
      max: 2,
      key: (req) => req.ip || "unknown",
    })
    const req = createReq()
    const res1 = createRes()
    const res2 = createRes()
    const res3 = createRes()

    expect(run(limiter, req, res1).nextCalled).toBe(true)
    expect(res1.statusCode).toBe(200)

    expect(run(limiter, req, res2).nextCalled).toBe(true)
    expect(res2.statusCode).toBe(200)

    expect(run(limiter, req, res3).nextCalled).toBe(false)
    expect(res3.statusCode).toBe(429)
    expect(res3.headers.get("RateLimit-Limit")).toBe("2")
  })

  test("tracks limits independently by key", () => {
    const limiter = createRateLimit({
      name: "by-key",
      windowMs: 60_000,
      max: 1,
      key: (req) => String(req.headers["x-key"] || "none"),
    })

    const resA1 = createRes()
    const resA2 = createRes()
    const resB1 = createRes()

    expect(run(limiter, createReq({ headers: { "x-key": "A" } as Request["headers"] }), resA1).nextCalled).toBe(true)
    expect(run(limiter, createReq({ headers: { "x-key": "A" } as Request["headers"] }), resA2).nextCalled).toBe(false)
    expect(resA2.statusCode).toBe(429)

    expect(run(limiter, createReq({ headers: { "x-key": "B" } as Request["headers"] }), resB1).nextCalled).toBe(true)
    expect(resB1.statusCode).toBe(200)
  })

  test("supports route skips", () => {
    const limiter = createRateLimit({
      name: "skip-health",
      windowMs: 60_000,
      max: 1,
      key: () => "same",
      skip: (req) => req.path === "/health",
    })

    const healthRes = createRes()
    const normalRes1 = createRes()
    const normalRes2 = createRes()

    expect(run(limiter, createReq({ path: "/health" }), healthRes).nextCalled).toBe(true)
    expect(run(limiter, createReq({ path: "/api" }), normalRes1).nextCalled).toBe(true)
    expect(run(limiter, createReq({ path: "/api" }), normalRes2).nextCalled).toBe(false)
    expect(normalRes2.statusCode).toBe(429)
  })
})

function expectLimitResult(
  middleware: ReturnType<typeof createRateLimit>,
  req: Request,
  expected: { nextCalled: boolean; statusCode: number; limit: string | undefined }
): void {
  const res = createRes()
  const { nextCalled } = run(middleware, req, res)
  expect({ nextCalled, statusCode: res.statusCode, limit: res.headers.get("RateLimit-Limit") }).toEqual(expected)
}

describe("createRateLimiters public API key limiters", () => {
  test("should pass a bot bearer through publicApiKey untouched and count it on publicApiBotKey when the token starts with threa_bk_", () => {
    const { publicApiKey, publicApiBotKey } = createRateLimiters({ globalMax: 300, authMax: 30 })
    const req = createReq({ headers: { authorization: "Bearer threa_bk_abc123" } as Request["headers"] })

    expectLimitResult(publicApiKey, req, { nextCalled: true, statusCode: 200, limit: undefined })
    expectLimitResult(publicApiBotKey, req, { nextCalled: true, statusCode: 200, limit: "300" })
  })

  test("should count a bearer on publicApiKey with limit 60 and pass it through publicApiBotKey untouched when the token is not a bot key", () => {
    const { publicApiKey, publicApiBotKey } = createRateLimiters({ globalMax: 300, authMax: 30 })
    const req = createReq({ headers: { authorization: "Bearer threa_pk_abc123" } as Request["headers"] })

    expectLimitResult(publicApiKey, req, { nextCalled: true, statusCode: 200, limit: "60" })
    expectLimitResult(publicApiBotKey, req, { nextCalled: true, statusCode: 200, limit: undefined })
  })

  test("should count the request on publicApiKey via IP fallback and pass it through publicApiBotKey untouched when there is no bearer", () => {
    const { publicApiKey, publicApiBotKey } = createRateLimiters({ globalMax: 300, authMax: 30 })
    const req = createReq()

    expectLimitResult(publicApiKey, req, { nextCalled: true, statusCode: 200, limit: "60" })
    expectLimitResult(publicApiBotKey, req, { nextCalled: true, statusCode: 200, limit: undefined })
  })
})

describe("createRateLimiters upload", () => {
  test("should give each bearer token on one IP its own upload budget", () => {
    const { upload } = createRateLimiters({ globalMax: 300, authMax: 30 })
    const first = createReq({ headers: { authorization: "Bearer threa_sk_first" } as Request["headers"] })
    const second = createReq({ headers: { authorization: "Bearer threa_sk_second" } as Request["headers"] })

    for (let i = 0; i < 60; i++) run(upload, first, createRes())
    const results = [first, second].map((req) => {
      const res = createRes()
      return { nextCalled: run(upload, req, res).nextCalled, statusCode: res.statusCode }
    })

    expect(results).toEqual([
      { nextCalled: false, statusCode: 429 },
      { nextCalled: true, statusCode: 200 },
    ])
  })
})

interface TextResponse extends MockResponse {
  sentType: string | null
}

function createTextRes(): Response & TextResponse {
  const res = createRes() as Response & TextResponse
  res.sentType = null
  Object.assign(res, {
    type: (value: string) => {
      res.sentType = value
      return res
    },
    send: (payload: unknown) => {
      res.body = payload
      return res
    },
  })
  return res
}

function exhaust(middleware: ReturnType<typeof createRateLimit>, req: Request, times: number): void {
  for (let i = 0; i < times; i++) run(middleware, req, createTextRes())
}

describe("createRateLimiters inbound webhook limiters", () => {
  const slackUrl = "/api/v1/workspaces/ws_1/hooks/hook_1/s3cr3t/slack"
  const nativeUrl = "/api/v1/workspaces/ws_1/hooks/hook_1/s3cr3t"

  test("should answer text/plain rate_limited with Retry-After when the slack route exceeds the per-hook limit", () => {
    const { incomingWebhookHook } = createRateLimiters({ globalMax: 300, authMax: 30 })
    const req = createReq({ originalUrl: slackUrl, params: { hookId: "hook_1" } } as Partial<Request>)
    exhaust(incomingWebhookHook, req, 60)

    const res = createTextRes()
    const { nextCalled } = run(incomingWebhookHook, req, res)

    expect({
      nextCalled,
      statusCode: res.statusCode,
      body: res.body,
      sentType: res.sentType,
      retryAfter: res.headers.get("Retry-After"),
    }).toEqual({ nextCalled: false, statusCode: 429, body: "rate_limited", sentType: "text/plain", retryAfter: "60" })
  })

  test("should answer the standard json shape when the native route exceeds the per-hook limit", () => {
    const { incomingWebhookHook } = createRateLimiters({ globalMax: 300, authMax: 30 })
    const req = createReq({ originalUrl: nativeUrl, params: { hookId: "hook_2" } } as Partial<Request>)
    exhaust(incomingWebhookHook, req, 60)

    const res = createTextRes()
    const { nextCalled } = run(incomingWebhookHook, req, res)

    expect({
      nextCalled,
      statusCode: res.statusCode,
      body: res.body,
      sentType: res.sentType,
      retryAfter: res.headers.get("Retry-After"),
    }).toEqual({
      nextCalled: false,
      statusCode: 429,
      body: { error: "Rate limit exceeded", limit: 60, windowMs: 60_000 },
      sentType: null,
      retryAfter: "60",
    })
  })

  test("should key the per-hook bucket on the hook id so two hooks from one ip do not share it", () => {
    const { incomingWebhookHook } = createRateLimiters({ globalMax: 300, authMax: 30 })
    exhaust(
      incomingWebhookHook,
      createReq({ originalUrl: nativeUrl, params: { hookId: "hook_a" } } as Partial<Request>),
      60
    )

    const res = createTextRes()
    const other = createReq({ originalUrl: nativeUrl, params: { hookId: "hook_b" } } as Partial<Request>)

    expect(run(incomingWebhookHook, other, res).nextCalled).toBe(true)
  })

  test("should leave inbound webhook requests to their own limiters when the global baseline is exhausted", () => {
    const { globalBaseline } = createRateLimiters({ globalMax: 2, authMax: 30 })
    exhaust(globalBaseline, createReq({ originalUrl: "/api/workspaces" } as Partial<Request>), 3)

    const outcomes = [slackUrl, nativeUrl, "/api/workspaces"].map((originalUrl) => {
      const res = createTextRes()
      const { nextCalled } = run(globalBaseline, createReq({ originalUrl } as Partial<Request>), res)
      return { originalUrl, nextCalled, statusCode: res.statusCode }
    })

    expect(outcomes).toEqual([
      { originalUrl: slackUrl, nextCalled: true, statusCode: 200 },
      { originalUrl: nativeUrl, nextCalled: true, statusCode: 200 },
      { originalUrl: "/api/workspaces", nextCalled: false, statusCode: 429 },
    ])
  })

  test("should cap secret guessing per ip before any hook is known when the ip limit is exceeded", () => {
    const { incomingWebhookIp } = createRateLimiters({ globalMax: 300, authMax: 30 })
    const req = createReq({ originalUrl: slackUrl, params: {} } as Partial<Request>)
    exhaust(incomingWebhookIp, req, 300)

    const res = createTextRes()
    const { nextCalled } = run(incomingWebhookIp, req, res)

    expect({ nextCalled, statusCode: res.statusCode, body: res.body }).toEqual({
      nextCalled: false,
      statusCode: 429,
      body: "rate_limited",
    })
  })
})
