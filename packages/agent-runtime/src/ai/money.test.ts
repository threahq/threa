import { describe, expect, test } from "bun:test"
import { ceilUsd, compareUsd, usd, usdForTokens, usdString, usdUnits } from "./money"

describe("exact USD amounts", () => {
  test("round-trips eight decimal places without floating point drift", () => {
    expect(usdUnits("0.1") + usdUnits("0.2")).toBe(usdUnits("0.3"))
    expect(usdString(usdUnits("1.23000001"))).toBe("1.23000001")
    expect(usdString(usdUnits("123456789012.99999999"))).toBe("123456789012.99999999")
    expect(usd("1.50000000")).toBe("1.5")
    expect(usd("0.00000000")).toBe("0")
  })

  test("compares by value, not by string", () => {
    expect(compareUsd("10.00000000", "10")).toBe(0)
    expect(compareUsd("9.99999999", "10")).toBe(-1)
    expect(compareUsd("10.00000001", "10")).toBe(1)
  })

  test("rejects negative, exponent, float-looking and over-precise input", () => {
    for (const bad of ["-1", "1e-3", "0.000000001", "1.", ".5", "01", "1,5", "", "NaN", "1234567890123"]) {
      expect(() => usdUnits(bad)).toThrow(/Invalid USD amount/)
    }
    expect(() => usdString(-1n)).toThrow(/Invalid USD amount/)
  })

  test("refuses sums that NUMERIC(20,8) cannot store instead of failing at the database", () => {
    expect(usdString(usdUnits("999999999999.99999999"))).toBe("999999999999.99999999")
    expect(() => usdString(usdUnits("999999999999.99999999") + 1n)).toThrow(/Invalid USD amount/)
  })
})

describe("provider decimal normalisation", () => {
  test("rounds provider charges and rates up to 1e-8 USD without floats", () => {
    expect(ceilUsd("0.0001234")).toBe("0.0001234")
    expect(ceilUsd("1.2e-7")).toBe("0.00000012")
    expect(ceilUsd("1e-9")).toBe("0.00000001")
    expect(ceilUsd("0.000123456789")).toBe("0.00012346")
    expect(ceilUsd("0.30000000000000004")).toBe("0.30000001")
    expect(ceilUsd("0.1234567800000000000001")).toBe("0.12345679")
    expect(ceilUsd("0")).toBe("0")
    expect(ceilUsd("2")).toBe("2")
    expect(ceilUsd("0.000000125")).toBe("0.00000013")
    expect(ceilUsd("2.5E-7")).toBe("0.00000025")
    expect(ceilUsd("1e3")).toBe("1000")
    expect(ceilUsd("0.46100000")).toBe("0.461")
  })

  test("multiplies a per-token rate exactly before rounding up", () => {
    expect(usdForTokens("0.000000125", 922000)).toBe("0.11525")
    expect(usdForTokens("0.0000005", 922000)).toBe("0.461")
    expect(usdForTokens("0.0000018", 8192)).toBe("0.0147456")
    expect(usdForTokens("0.0000000001", 3)).toBe("0.00000001")
    expect(usdForTokens("1e-7", 0)).toBe("0")
  })

  test("refuses negative, non-finite, malformed and overflowing values", () => {
    for (const bad of ["-0.1", "-1", "NaN", "Infinity", "1e13", "abc", "", "1.", ".5", "1e", "1,5", "1000000000000"]) {
      expect(() => ceilUsd(bad)).toThrow(/Invalid USD amount/)
    }
    expect(() => usdForTokens("0.0000005", -1)).toThrow(/Invalid USD amount/)
    expect(() => usdForTokens("0.0000005", 1.5)).toThrow(/Invalid USD amount/)
    expect(() => usdForTokens("1", 1_000_000_000_000)).toThrow(/Invalid USD amount/)
    expect(() => usdForTokens("0.0000005", Number.MAX_SAFE_INTEGER + 1)).toThrow(/Invalid USD amount/)
  })

  test("bounds digit and exponent length so a hostile value cannot force huge powers", () => {
    expect(ceilUsd("1e-64")).toBe("0.00000001")
    expect(ceilUsd("0e64")).toBe("0")
    for (const bad of ["1e-65", "1e65", "1e999999999", "1e-999999999", `1${"0".repeat(40)}`, `0.${"0".repeat(40)}1`]) {
      expect(() => ceilUsd(bad)).toThrow(/Invalid USD amount/)
    }
    expect(() => ceilUsd("5e-324")).toThrow(/Invalid USD amount/)
    expect(() => ceilUsd("1.7976931348623157e308")).toThrow(/Invalid USD amount/)
  })
})
