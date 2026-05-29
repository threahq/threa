import { describe, expect, it } from "vitest"
import type { NextFunction, Request, Response } from "express"
import { INTERNAL_API_KEY_HEADER } from "@threa/types"
import { requireInternalKey } from "./invoke"

describe("requireInternalKey", () => {
  function fakeReq(headerValue: string | undefined): Request {
    return {
      header: (name: string) => (name === INTERNAL_API_KEY_HEADER ? headerValue : undefined),
    } as unknown as Request
  }
  function fakeRes(): Response & { statusCode: number } {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json() {
        return this
      },
    }
    return res as unknown as Response & { statusCode: number }
  }

  it("401s and does not call next when the header is missing", () => {
    const res = fakeRes()
    let nexted = false
    requireInternalKey("shared-secret")(fakeReq(undefined), res, (() => {
      nexted = true
    }) as NextFunction)
    expect(res.statusCode).toBe(401)
    expect(nexted).toBe(false)
  })

  it("401s when the internal-api-key is wrong", () => {
    const res = fakeRes()
    let nexted = false
    requireInternalKey("shared-secret")(fakeReq("not-the-secret"), res, (() => {
      nexted = true
    }) as NextFunction)
    expect(res.statusCode).toBe(401)
    expect(nexted).toBe(false)
  })

  it("calls next when the key matches", () => {
    const res = fakeRes()
    let nexted = false
    requireInternalKey("shared-secret")(fakeReq("shared-secret"), res, (() => {
      nexted = true
    }) as NextFunction)
    expect(nexted).toBe(true)
    expect(res.statusCode).toBe(200)
  })
})
