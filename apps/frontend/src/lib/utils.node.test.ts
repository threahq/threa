import { describe, it, expect } from "vitest"
import { escapeHtml } from "./utils"

describe("escapeHtml", () => {
  it("should escape ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar")
  })

  it("should escape less than signs", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;")
  })

  it("should escape greater than signs", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b")
  })

  it("should handle multiple escapes in one string", () => {
    expect(escapeHtml("<div>Tom & Jerry</div>")).toBe("&lt;div&gt;Tom &amp; Jerry&lt;/div&gt;")
  })

  it("should return empty string for empty input", () => {
    expect(escapeHtml("")).toBe("")
  })

  it("should not modify strings without special characters", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World")
  })
})
