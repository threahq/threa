import { describe, expect, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { INTERNAL_API_KEY_HEADER } from "@threa/types"
import { HttpError } from "../errors"
import { createInternalAuthMiddleware } from "./internal-auth"

/** Run the middleware against a request presenting `key` (or no header) and return what it passed to next(). */
function run(middleware: ReturnType<typeof createInternalAuthMiddleware>, key?: string): unknown {
  let passed: unknown = "next-not-called"
  const headers = key === undefined ? {} : { [INTERNAL_API_KEY_HEADER.toLowerCase()]: key }
  middleware(
    { headers } as Request,
    {} as Response,
    ((err?: unknown) => {
      passed = err
    }) as NextFunction
  )
  return passed
}

describe("createInternalAuthMiddleware", () => {
  test("accepts the configured key", () => {
    const middleware = createInternalAuthMiddleware("secret-a")
    expect(run(middleware, "secret-a")).toBeUndefined()
  })

  test("rejects a missing header with 401", () => {
    const middleware = createInternalAuthMiddleware("secret-a")
    const err = run(middleware)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(401)
  })

  test("rejects a wrong key with 401", () => {
    const middleware = createInternalAuthMiddleware("secret-a")
    const err = run(middleware, "secret-b")
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(401)
  })

  // Phase 2.4c (E2EE-22): credential separation is two middleware instances
  // with different secrets — the shared INTERNAL_API_KEY must not open the
  // enclave routes, and the enclave credential must not open the other
  // internal routes. Same-length keys so only the value differs.
  test("instances with different secrets reject each other's keys", () => {
    const internalAuth = createInternalAuthMiddleware("internal-key-1")
    const enclaveAuth = createInternalAuthMiddleware("enclaved-key-1")

    expect(run(internalAuth, "internal-key-1")).toBeUndefined()
    expect(run(enclaveAuth, "enclaved-key-1")).toBeUndefined()
    expect((run(internalAuth, "enclaved-key-1") as HttpError).status).toBe(401)
    expect((run(enclaveAuth, "internal-key-1") as HttpError).status).toBe(401)
  })
})
