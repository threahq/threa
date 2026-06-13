import { describe, test, expect } from "bun:test"
import { isValidSlug, isBroadcastSlug, SLUG_MAX_LENGTH } from "./slug"

describe("slug validation", () => {
  describe("isValidSlug", () => {
    test("accepts valid slugs", () => {
      const validSlugs = [
        "ariadne",
        "alice",
        "user-1",
        "customer-support",
        "a",
        "a1",
        "team-42",
        "q1-2025-planning",
        "tech_lead",
        "hello_world",
        "team_alpha-1",
        "teamx__alerts-info", // consecutive separators allowed
        "foo--bar",
        "a__b",
      ]

      for (const slug of validSlugs) {
        expect(isValidSlug(slug)).toBe(true)
      }
    })

    test("rejects invalid slugs", () => {
      const invalidSlugs = [
        "", // empty
        "123", // starts with number
        "1abc", // starts with number
        "-abc", // starts with hyphen
        "_abc", // starts with underscore
        "abc-", // ends with hyphen
        "abc_", // ends with underscore
        "ABC", // uppercase
        "aBc", // mixed case
        "hello.world", // dot
        "hello world", // space
        "café", // unicode
        "a".repeat(SLUG_MAX_LENGTH + 1), // too long
      ]

      for (const slug of invalidSlugs) {
        expect(isValidSlug(slug)).toBe(false)
      }
    })

    test("accepts maximum length slug", () => {
      const maxSlug = "a".repeat(SLUG_MAX_LENGTH)
      expect(isValidSlug(maxSlug)).toBe(true)
    })
  })

  describe("isBroadcastSlug", () => {
    test("returns true for 'channel'", () => {
      expect(isBroadcastSlug("channel")).toBe(true)
    })

    test("returns true for 'here'", () => {
      expect(isBroadcastSlug("here")).toBe(true)
    })

    test("returns false for user slugs", () => {
      expect(isBroadcastSlug("alice")).toBe(false)
      expect(isBroadcastSlug("ariadne")).toBe(false)
    })

    test("returns false for empty string", () => {
      expect(isBroadcastSlug("")).toBe(false)
    })
  })
})
