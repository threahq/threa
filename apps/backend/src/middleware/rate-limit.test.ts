import { describe, expect, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { createRateLimit } from "@threahq/backend-common"

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
