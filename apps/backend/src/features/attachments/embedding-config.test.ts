import { describe, it, expect } from "bun:test"
import { ExtractionContentTypes } from "@threahq/types"
import { isContentTypeEmbeddable } from "./embedding-config"

describe("isContentTypeEmbeddable", () => {
  it("returns true for content types whose summary carries domain-specific signal", () => {
    expect(isContentTypeEmbeddable(ExtractionContentTypes.CHART)).toBe(true)
    expect(isContentTypeEmbeddable(ExtractionContentTypes.TABLE)).toBe(true)
    expect(isContentTypeEmbeddable(ExtractionContentTypes.DIAGRAM)).toBe(true)
    expect(isContentTypeEmbeddable(ExtractionContentTypes.SCREENSHOT)).toBe(true)
    expect(isContentTypeEmbeddable(ExtractionContentTypes.DOCUMENT)).toBe(true)
  })

  it("returns false for content types whose summary tends to be too generic to retrieve on", () => {
    expect(isContentTypeEmbeddable(ExtractionContentTypes.PHOTO)).toBe(false)
    expect(isContentTypeEmbeddable(ExtractionContentTypes.OTHER)).toBe(false)
  })
})
