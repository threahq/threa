import { describe, expect, test } from "bun:test"
import { HttpError } from "@threahq/backend-common"
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

  test("rejects non-allowlisted origins", () => {
    const checker = createCorsOriginChecker(["https://app.example.com"])

    let rejection: unknown
    checker("https://evil.example.com", (err) => {
      rejection = err
    })

    expect(rejection).toBeInstanceOf(HttpError)
    const { message, status, code } = rejection as HttpError
    expect({ message, status, code }).toEqual({
      message: "CORS origin not allowed",
      status: 403,
      code: "CORS_ORIGIN_NOT_ALLOWED",
    })
  })
})
