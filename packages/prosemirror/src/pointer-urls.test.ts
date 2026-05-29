import { describe, expect, it } from "bun:test"
import { buildMemoHref, parseMemoHref } from "./pointer-urls"

describe("parseMemoHref", () => {
  it("round-trips a canonical memo id", () => {
    const href = buildMemoHref({ memoId: "memo_01ABC" })
    expect(href).toBe("memo:memo_01ABC")
    expect(parseMemoHref(href)).toEqual({ memoId: "memo_01ABC" })
  })

  it("returns null for a non-memo href", () => {
    expect(parseMemoHref("shared-message:stream_1/msg_1")).toBeNull()
    expect(parseMemoHref("https://example.com")).toBeNull()
  })

  it("returns null for an empty id", () => {
    expect(parseMemoHref("memo:")).toBeNull()
  })

  it("rejects ids with a path, query, or fragment suffix", () => {
    expect(parseMemoHref("memo:memo_123/extra")).toBeNull()
    expect(parseMemoHref("memo:memo_123?x=1")).toBeNull()
    expect(parseMemoHref("memo:memo_123#frag")).toBeNull()
    expect(parseMemoHref("memo:memo_123:more")).toBeNull()
  })
})
