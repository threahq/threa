import { describe, expect, it } from "vitest"
import { ATTACHMENT_CATEGORIES, type AttachmentCategory } from "@threahq/types"
import { CATEGORY_META, CATEGORY_OPTIONS } from "./category"

describe("CATEGORY_META", () => {
  it("provides UI metadata for every shared category — keeps backend filter list and frontend rendering in lockstep", () => {
    for (const cat of ATTACHMENT_CATEGORIES) {
      const meta = CATEGORY_META[cat]
      expect(meta).toBeDefined()
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.icon).toBeDefined()
      expect(meta.accent.length).toBeGreaterThan(0)
    }
  })
})

describe("CATEGORY_OPTIONS", () => {
  it("matches the canonical category order from @threahq/types", () => {
    expect(CATEGORY_OPTIONS.map((o) => o.value)).toEqual(ATTACHMENT_CATEGORIES)
  })

  it("uses CATEGORY_META labels (no parallel translations)", () => {
    for (const opt of CATEGORY_OPTIONS) {
      expect(opt.label).toBe(CATEGORY_META[opt.value as AttachmentCategory].label)
    }
  })
})
