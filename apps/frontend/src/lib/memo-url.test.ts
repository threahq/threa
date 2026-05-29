import { describe, expect, it } from "vitest"
import { parseMemoUrl } from "./memo-url"

const origin = window.location.origin

describe("parseMemoUrl", () => {
  it("extracts the memo id from an in-app memory-explorer link", () => {
    expect(parseMemoUrl(`${origin}/w/ws_123/memory?memo=memo_abc`)).toBe("memo_abc")
  })

  it("accepts a relative memory-explorer link", () => {
    expect(parseMemoUrl("/w/ws_123/memory?memo=memo_abc")).toBe("memo_abc")
  })

  it("tolerates a trailing slash on the memory path", () => {
    expect(parseMemoUrl(`${origin}/w/ws_123/memory/?memo=memo_abc`)).toBe("memo_abc")
  })

  it("returns null for off-origin links even when the shape matches", () => {
    expect(parseMemoUrl("https://evil.example.com/w/ws_123/memory?memo=memo_abc")).toBeNull()
  })

  it("returns null when the path is not the memory explorer", () => {
    expect(parseMemoUrl(`${origin}/w/ws_123/streams?memo=memo_abc`)).toBeNull()
  })

  it("returns null for an unrelated path that merely ends in /memory", () => {
    expect(parseMemoUrl(`${origin}/admin/memory?memo=memo_abc`)).toBeNull()
  })

  it("returns null when the memo param is missing", () => {
    expect(parseMemoUrl(`${origin}/w/ws_123/memory`)).toBeNull()
  })

  it("returns null when the memo param isn't a memo id", () => {
    expect(parseMemoUrl(`${origin}/w/ws_123/memory?memo=stream_abc`)).toBeNull()
  })

  it("returns null for arbitrary text that isn't a memory link", () => {
    expect(parseMemoUrl("not a url at all")).toBeNull()
  })
})
