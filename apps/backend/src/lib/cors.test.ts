import { describe, expect, spyOn, test } from "bun:test"
import { HttpError, logger } from "@threahq/backend-common"
import { createCorsOriginChecker } from "./cors"

describe("createCorsOriginChecker", () => {
  test("allows configured origins", () => {
    const checker = createCorsOriginChecker(["https://app.example.com"])

    let allowed: boolean | undefined
    checker("https://app.example.com", (err, result) => {
      expect(err).toBeNull()
      allowed = result as boolean
    })

    expect(allowed).toBe(true)
  })

  test("allows requests without Origin header", () => {
    const checker = createCorsOriginChecker(["https://app.example.com"])

    let allowed: boolean | undefined
    checker(undefined, (err, result) => {
      expect(err).toBeNull()
      allowed = result as boolean
    })

    expect(allowed).toBe(true)
  })

  test("rejects non-allowlisted origins and records which origin it was", () => {
    const checker = createCorsOriginChecker(["https://app.example.com"])
    const warnings: unknown[] = []
    const warn = spyOn(logger, "warn").mockImplementation(((data: unknown) => {
      warnings.push(data)
    }) as never)

    let rejection: unknown
    try {
      checker("https://evil.example.com", (err) => {
        rejection = err
      })
    } finally {
      warn.mockRestore()
    }

    expect(warnings).toEqual([{ origin: "https://evil.example.com" }])

    expect(rejection).toBeInstanceOf(HttpError)
    const { message, status, code } = rejection as HttpError
    expect({ message, status, code }).toEqual({
      message: "CORS origin not allowed",
      status: 403,
      code: "CORS_ORIGIN_NOT_ALLOWED",
    })
  })
})
