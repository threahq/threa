import { describe, expect, it } from "vitest"
import { extractMemoRefs } from "./memo-refs"

describe("extractMemoRefs", () => {
  it("returns no refs for a body without memo links", () => {
    expect(extractMemoRefs("just some text with a [link](https://example.com)")).toEqual([])
  })

  it("extracts a memo ref with its title", () => {
    expect(extractMemoRefs("See [Auth rewrite](memo:memo_01ABC) for details")).toEqual([
      { memoId: "memo_01ABC", title: "Auth rewrite" },
    ])
  })

  it("de-duplicates repeated references by memoId, keeping the first title", () => {
    const md = "[Auth rewrite](memo:memo_01ABC) and again [Auth v2](memo:memo_01ABC)"
    expect(extractMemoRefs(md)).toEqual([{ memoId: "memo_01ABC", title: "Auth rewrite" }])
  })

  it("preserves order and keeps distinct memos separate", () => {
    const md = "[First](memo:memo_one)\n\n[Second](memo:memo_two)"
    expect(extractMemoRefs(md)).toEqual([
      { memoId: "memo_one", title: "First" },
      { memoId: "memo_two", title: "Second" },
    ])
  })

  it("unescapes brackets and backslashes in the title", () => {
    expect(extractMemoRefs("[Auth [v2\\]\\\\rewrite](memo:memo_01ABC)")).toEqual([
      { memoId: "memo_01ABC", title: "Auth [v2]\\rewrite" },
    ])
  })
})
