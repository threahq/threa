import { describe, it, expect } from "vitest"
import { clamp } from "./math-utils"

describe("clamp", () => {
  it("should clamp a value to a range", () => {
    expect(clamp(0, 0, 10)).toBe(0)
    expect(clamp(10, 0, 10)).toBe(10)
    expect(clamp(5, 0, 10)).toBe(5)
  })
})
