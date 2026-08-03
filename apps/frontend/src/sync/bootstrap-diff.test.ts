import { describe, it, expect } from "vitest"
import { SERVER_STAMP_IGNORED_KEYS, diffRows, diffSingleton, semanticEqual } from "./bootstrap-diff"

describe("bootstrap diff", () => {
  it("equal rows differing only in _cachedAt are unchanged", () => {
    const existing = { id: "stream_1", name: "General", _cachedAt: 1 }
    const candidate = { id: "stream_1", name: "General", _cachedAt: 999 }
    const result = diffRows(new Map([[existing.id, existing]]), [candidate])
    expect(result.toWrite).toEqual([])
    expect(result.skipped).toBe(1)
    expect(result.merged[0]).toBe(existing)
  })

  it("key order does not make a row look changed", () => {
    const existing = { id: "stream_1", a: 1, b: { x: 1, y: 2 }, _cachedAt: 1 }
    const candidate = { id: "stream_1", b: { y: 2, x: 1 }, a: 1, _cachedAt: 2 }
    expect(JSON.stringify(existing)).not.toBe(JSON.stringify(candidate))
    expect(diffRows(new Map([["stream_1", existing]]), [candidate]).toWrite).toEqual([])
  })

  it("a missing key equals an explicit undefined", () => {
    const existing = { id: "stream_1", a: 1 }
    const candidate = { id: "stream_1", a: 1, contextBag: undefined }
    expect(semanticEqual(existing, candidate)).toBe(true)
    expect(diffRows(new Map([["stream_1", existing]]), [candidate]).toWrite).toEqual([])
  })

  it("a nested payload change is detected", () => {
    const existing = { id: "stream_1", lastMessagePreview: { content: "hi", authorId: "usr_1" }, _cachedAt: 1 }
    const candidate = { id: "stream_1", lastMessagePreview: { content: "hey", authorId: "usr_1" }, _cachedAt: 1 }
    const result = diffRows(new Map([["stream_1", existing]]), [candidate])
    expect(result.toWrite).toEqual([candidate])
    expect(result.merged[0]).toBe(candidate)
    expect(result.skipped).toBe(0)
  })

  it("exotic instances always write — the diff never silently skips them", () => {
    expect(semanticEqual(new Date(0), new Date(9e9))).toBe(false)
    expect(semanticEqual(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(false)
    const same = new Date(0)
    expect(semanticEqual(same, same)).toBe(true)
  })

  it("a nested array reorder is a change", () => {
    const existing = { id: "stream_1", members: ["usr_1", "usr_2"] }
    const candidate = { id: "stream_1", members: ["usr_2", "usr_1"] }
    expect(semanticEqual(existing, candidate)).toBe(false)
    expect(diffRows(new Map([["stream_1", existing]]), [candidate]).toWrite).toEqual([candidate])
  })

  it("a row absent from existing is always written", () => {
    const candidate = { id: "stream_new", name: "New" }
    const result = diffRows(new Map(), [candidate])
    expect(result).toEqual({ toWrite: [candidate], merged: [candidate], skipped: 0 })
  })

  it("a row absent from candidates is neither written nor merged", () => {
    const orphan = { id: "stream_gone", name: "Gone" }
    const candidate = { id: "stream_1", name: "Here" }
    const result = diffRows(
      new Map([
        [orphan.id, orphan],
        [candidate.id, candidate],
      ]),
      [candidate]
    )
    expect(result.toWrite).toEqual([])
    expect(result.merged).toEqual([candidate])
    expect(result.merged).not.toContain(orphan)
  })

  it("a caller's ignore set applies to the top level only", () => {
    const withNested = (top: string, nested: string) => ({ id: "x", updatedAt: top, nested: { updatedAt: nested } })
    expect(semanticEqual(withNested("A", "A"), withNested("B", "A"), SERVER_STAMP_IGNORED_KEYS)).toBe(true)
    expect(semanticEqual(withNested("A", "A"), withNested("B", "B"), SERVER_STAMP_IGNORED_KEYS)).toBe(false)
  })

  it("diffSingleton reports write:false and returns the existing object", () => {
    const existing = { id: "ws_1", config: { preset: "default" }, _cachedAt: 1 }
    const candidate = { id: "ws_1", config: { preset: "default" }, _cachedAt: 42 }
    const result = diffSingleton(existing, candidate)
    expect(result.write).toBe(false)
    expect(result.merged).toBe(existing)
    expect(diffSingleton(undefined, candidate)).toEqual({ write: true, merged: candidate })
  })
})
