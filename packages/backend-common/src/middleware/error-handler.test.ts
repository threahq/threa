import { describe, expect, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { HttpError } from "../errors"
import type { AnalyticsEvent, AnalyticsReporter, ExceptionContext } from "../posthog/reporter"
import { createErrorHandler } from "./error-handler"

function makeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; body: unknown }
}

function makeRecordingReporter(): AnalyticsReporter & { calls: { error: unknown; context?: ExceptionContext }[] } {
  const calls: { error: unknown; context?: ExceptionContext }[] = []
  return {
    calls,
    captureException(error: unknown, context?: ExceptionContext) {
      calls.push({ error, context })
    },
    captureEvent(_event: AnalyticsEvent) {},
    async shutdown() {},
  }
}

const req = { path: "/x", method: "GET" } as unknown as Request
const next = (() => {}) as unknown as NextFunction

describe("errorHandler", () => {
  test("formats an HttpError with status, message, code, and details", () => {
    const res = makeRes()
    const errorHandler = createErrorHandler({ analyticsReporter: makeRecordingReporter() })

    errorHandler(
      new HttpError("Validation failed", {
        status: 400,
        code: "VALIDATION_ERROR",
        details: { name: ["Required"] },
      }),
      req,
      res,
      next
    )

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: { name: ["Required"] },
    })
  })

  test("omits code and details when not provided", () => {
    const res = makeRes()
    const errorHandler = createErrorHandler({ analyticsReporter: makeRecordingReporter() })

    errorHandler(new HttpError("Nope", { status: 404 }), req, res, next)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: "Nope" })
  })

  test("surfaces unknown errors as a 500", () => {
    const res = makeRes()
    const errorHandler = createErrorHandler({ analyticsReporter: makeRecordingReporter() })

    errorHandler(new Error("boom"), req, res, next)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: "Internal server error", code: "INTERNAL_ERROR" })
  })

  test("should capture an unexpected error with the request identity when the user is authenticated", () => {
    const res = makeRes()
    const reporter = makeRecordingReporter()
    const errorHandler = createErrorHandler({ analyticsReporter: reporter })
    const err = new Error("boom")
    const req = {
      path: "/x",
      method: "GET",
      authUser: { id: "user_01JQ8ZP4K6", email: "a@example.com", firstName: null, lastName: null, permissions: null },
    } as unknown as Request

    errorHandler(err, req, res, next)

    expect(reporter.calls).toEqual([
      {
        error: err,
        context: { distinctId: "user_01JQ8ZP4K6", properties: { path: "/x", method: "GET", status_code: 500 } },
      },
    ])
  })

  test("should replace entity ids in the reported path", () => {
    const res = makeRes()
    const reporter = makeRecordingReporter()
    const errorHandler = createErrorHandler({ analyticsReporter: reporter })
    const err = new Error("boom")
    const req = {
      path: "/api/streams/stream_01JQ8ZP4K6/read-state",
      method: "POST",
    } as unknown as Request

    errorHandler(err, req, res, next)

    expect(reporter.calls).toEqual([
      {
        error: err,
        context: { properties: { path: "/api/streams/:id/read-state", method: "POST", status_code: 500 } },
      },
    ])
  })

  test("should capture with no distinct id when unauthenticated", () => {
    const res = makeRes()
    const reporter = makeRecordingReporter()
    const errorHandler = createErrorHandler({ analyticsReporter: reporter })
    const err = new Error("boom")

    errorHandler(err, req, res, next)

    expect(reporter.calls).toEqual([
      {
        error: err,
        context: { properties: { path: "/x", method: "GET", status_code: 500 } },
      },
    ])
  })

  test("should not capture an HttpError", () => {
    const res = makeRes()
    const reporter = makeRecordingReporter()
    const errorHandler = createErrorHandler({ analyticsReporter: reporter })

    errorHandler(new HttpError("Nope", { status: 404 }), req, res, next)

    expect(reporter.calls).toEqual([])
  })
})
