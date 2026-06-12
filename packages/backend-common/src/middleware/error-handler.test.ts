import { describe, expect, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { HttpError } from "../errors"
import { errorHandler } from "./error-handler"

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

const req = { path: "/x", method: "GET" } as unknown as Request
const next = (() => {}) as unknown as NextFunction

describe("errorHandler", () => {
  test("formats an HttpError with status, message, code, and details", () => {
    const res = makeRes()
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
    errorHandler(new HttpError("Nope", { status: 404 }), req, res, next)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: "Nope" })
  })

  test("surfaces unknown errors as a 500", () => {
    const res = makeRes()
    errorHandler(new Error("boom"), req, res, next)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: "Internal server error", code: "INTERNAL_ERROR" })
  })
})
