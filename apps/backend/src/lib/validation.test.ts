import { describe, it, expect } from "bun:test"
import { HttpError } from "@threahq/backend-common"
import { z } from "zod"
import { validateRequest } from "./validation"

const schema = z.object({
  name: z.string().min(1),
  age: z.number().int(),
})

describe("validateRequest", () => {
  it("returns the parsed, typed data on success", () => {
    expect(validateRequest(schema, { name: "ada", age: 36 })).toEqual({ name: "ada", age: 36 })
  })

  it("throws an HttpError carrying status 400, code, and flattened field errors", () => {
    let thrown: unknown
    try {
      validateRequest(schema, { name: "", age: "old" })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(HttpError)
    const err = thrown as HttpError
    expect({ message: err.message, status: err.status, code: err.code, details: err.details }).toEqual({
      message: "Validation failed",
      status: 400,
      code: "VALIDATION_ERROR",
      details: {
        name: ["Too small: expected string to have >=1 characters"],
        age: ["Invalid input: expected number, received string"],
      },
    })
  })
})
