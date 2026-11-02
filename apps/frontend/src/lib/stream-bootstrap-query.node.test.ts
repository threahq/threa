import { describe, expect, it } from "vitest"
import { ApiError } from "@/api/client"
import { bootstrapRetry, bootstrapRetryDelay } from "./stream-bootstrap-query"

describe("bootstrapRetry", () => {
  it("retries recoverable errors up to MAX_BOOTSTRAP_RETRIES", () => {
    const networkError = new Error("network down")
    expect(bootstrapRetry(0, networkError)).toBe(true)
    expect(bootstrapRetry(1, networkError)).toBe(true)
    expect(bootstrapRetry(2, networkError)).toBe(false)
  })

  it("retries 429 and 5xx API errors", () => {
    expect(bootstrapRetry(0, new ApiError(429, "RATE_LIMITED", "Slow"))).toBe(true)
    expect(bootstrapRetry(0, new ApiError(500, "INTERNAL", "Boom"))).toBe(true)
    expect(bootstrapRetry(0, new ApiError(503, "UNAVAILABLE", "Unavailable"))).toBe(true)
  })

  it("does not retry terminal 403/404 errors", () => {
    expect(bootstrapRetry(0, new ApiError(403, "FORBIDDEN", "Forbidden"))).toBe(false)
    expect(bootstrapRetry(0, new ApiError(404, "NOT_FOUND", "Not found"))).toBe(false)
  })

  it("does not retry non-recoverable 4xx errors", () => {
    expect(bootstrapRetry(0, new ApiError(400, "BAD_REQUEST", "Bad request"))).toBe(false)
    expect(bootstrapRetry(0, new ApiError(401, "UNAUTHORIZED", "Unauthorized"))).toBe(false)
  })
})

describe("bootstrapRetryDelay", () => {
  it("uses exponential backoff capped at the max delay", () => {
    expect(bootstrapRetryDelay(0)).toBe(500)
    expect(bootstrapRetryDelay(1)).toBe(1000)
    expect(bootstrapRetryDelay(2)).toBe(2000)
    expect(bootstrapRetryDelay(10)).toBe(4000)
  })
})
