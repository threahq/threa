import { describe, expect, test } from "bun:test"
import { searchQuerySchema } from "./handlers"

describe("searchQuerySchema", () => {
  test("accepts up to five non-empty exact phrases", () => {
    expect(searchQuerySchema.parse({ query: "created pr", phrases: ["1429"] }).phrases).toEqual(["1429"])
    expect(() => searchQuerySchema.parse({ phrases: [""] })).toThrow()
    expect(() => searchQuerySchema.parse({ phrases: ["1", "2", "3", "4", "5", "6"] })).toThrow()
  })
})
