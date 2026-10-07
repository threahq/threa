import { describe, expect, it } from "bun:test"
import { truncateCodePoints } from "./truncate"

describe("truncateCodePoints", () => {
  it("keeps an emoji whole when the cut lands inside its surrogate pair", () => {
    const text = `${"a".repeat(199)}😀 tail`
    const cut = truncateCodePoints(text, 200, "…")
    expect({ cut, wellFormed: cut.isWellFormed() }).toEqual({ cut: `${"a".repeat(199)}😀…`, wellFormed: true })
  })

  it("returns text within the limit unchanged, without the suffix", () => {
    expect(truncateCodePoints(`${"a".repeat(199)}😀`, 200, "…")).toBe(`${"a".repeat(199)}😀`)
  })
})
