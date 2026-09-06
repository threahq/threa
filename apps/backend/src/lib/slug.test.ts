import { describe, test, expect } from "bun:test"
import { generateSlug, generateUniqueSlug } from "@threahq/backend-common"

describe("Slug Generation", () => {
  describe("generateSlug", () => {
    test("should convert to lowercase and hyphenate", () => {
      expect(generateSlug("My Workspace")).toBe("my-workspace")
      expect(generateSlug("UPPERCASE")).toBe("uppercase")
      expect(generateSlug("MixedCase")).toBe("mixedcase")
    })

    test("should replace spaces with hyphens", () => {
      expect(generateSlug("my workspace")).toBe("my-workspace")
      expect(generateSlug("multiple   spaces")).toBe("multiple-spaces")
    })

    test("should preserve numbers", () => {
      expect(generateSlug("project123")).toBe("project123")
      expect(generateSlug("Team 42")).toBe("team-42")
    })

    test("should trim leading and trailing hyphens", () => {
      expect(generateSlug("-leading")).toBe("leading")
      expect(generateSlug("trailing-")).toBe("trailing")
      expect(generateSlug("--both--")).toBe("both")
      expect(generateSlug("!special!")).toBe("special")
    })

    test("should collapse multiple hyphens into one", () => {
      expect(generateSlug("multiple---hyphens")).toBe("multiple-hyphens")
      expect(generateSlug("test   space   here")).toBe("test-space-here")
    })

    test("should truncate to 50 characters", () => {
      const longName = "a".repeat(100)
      const slug = generateSlug(longName)
      expect(slug.length).toBe(50)
      expect(slug).toBe("a".repeat(50))
    })

    test("should return empty string for empty input", () => {
      expect(generateSlug("")).toBe("")
    })

    test("should transliterate accented Latin characters", () => {
      expect(generateSlug("café")).toBe("cafe")
      expect(generateSlug("Strömsö")).toBe("stroemsoe")
      expect(generateSlug("Ärligt Talat")).toBe("aerligt-talat")
      expect(generateSlug("Müller")).toBe("mueller")
      expect(generateSlug("naïve résumé")).toBe("naive-resume")
    })

    test("should transliterate non-decomposable characters", () => {
      expect(generateSlug("Ærø")).toBe("aero")
      expect(generateSlug("Straße")).toBe("strasse")
      expect(generateSlug("Łódź")).toBe("lodz")
      expect(generateSlug("Bjørn")).toBe("bjorn")
    })

    test("should transliterate CJK to pinyin", () => {
      expect(generateSlug("日本語")).toBe("ri-ben-yu")
    })

    test("should handle real-world workspace names", () => {
      expect(generateSlug("Acme Corporation")).toBe("acme-corporation")
      expect(generateSlug("John's Team")).toBe("johns-team")
      expect(generateSlug("Q1 2025 Planning")).toBe("q1-2025-planning")
      expect(generateSlug("Engineering (Frontend)")).toBe("engineering-frontend")
    })
  })

  describe("generateUniqueSlug", () => {
    test("should return base slug when no collision", async () => {
      const checkExists = async () => false
      const slug = await generateUniqueSlug("My Workspace", checkExists)
      expect(slug).toBe("my-workspace")
    })

    test("should append suffix on first collision", async () => {
      const existingSlugs = new Set(["my-workspace"])
      const checkExists = async (slug: string) => existingSlugs.has(slug)
      const slug = await generateUniqueSlug("My Workspace", checkExists)
      expect(slug).toBe("my-workspace-1")
    })

    test("should increment suffix until unique", async () => {
      const existingSlugs = new Set(["my-workspace", "my-workspace-1", "my-workspace-2"])
      const checkExists = async (slug: string) => existingSlugs.has(slug)
      const slug = await generateUniqueSlug("My Workspace", checkExists)
      expect(slug).toBe("my-workspace-3")
    })

    test("should default to 'workspace' for empty base slug", async () => {
      const checkExists = async () => false
      const slug = await generateUniqueSlug("", checkExists)
      expect(slug).toBe("workspace")
    })

    test("should handle empty base slug with collision", async () => {
      const existingSlugs = new Set(["workspace"])
      const checkExists = async (slug: string) => existingSlugs.has(slug)
      const slug = await generateUniqueSlug("", checkExists)
      expect(slug).toBe("workspace-1")
    })

    test("should truncate base to leave room for suffix", async () => {
      const longName = "a".repeat(60)
      const existingSlugs = new Set(["a".repeat(50)])
      const checkExists = async (slug: string) => existingSlugs.has(slug)

      const slug = await generateUniqueSlug(longName, checkExists)

      expect(slug).toBe("a".repeat(44) + "-1")
      expect(slug.length).toBeLessThanOrEqual(50)
    })

    test("should handle high collision counts", async () => {
      const existingSlugs = new Set<string>()
      for (let i = 0; i <= 100; i++) {
        existingSlugs.add(i === 0 ? "test" : `test-${i}`)
      }
      const checkExists = async (slug: string) => existingSlugs.has(slug)

      const slug = await generateUniqueSlug("Test", checkExists)
      expect(slug).toBe("test-101")
    })

    test("should produce same slug regardless of input case", async () => {
      const checkExists = async () => false

      const slug1 = await generateUniqueSlug("My Team", checkExists)
      const slug2 = await generateUniqueSlug("MY TEAM", checkExists)
      const slug3 = await generateUniqueSlug("my team", checkExists)

      expect(slug1).toBe("my-team")
      expect(slug2).toBe("my-team")
      expect(slug3).toBe("my-team")
    })
  })
})
