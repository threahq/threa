import { describe, expect, it } from "vitest"
import { createStableSelect, shareById, shareMap } from "./structural-sharing"

const row = (id: string, preview: string) => ({ id, lastMessagePreview: { content: preview } })

describe("shareById", () => {
  it("returns the previous array when a rebuild changed nothing", () => {
    const prev = [row("a", "one"), row("b", "two")]
    expect(shareById(prev, [row("a", "one"), row("b", "two")])).toBe(prev)
  })

  it("keeps unchanged rows and replaces only the changed one", () => {
    const prev = [row("a", "one"), row("b", "two")]
    const next = [row("a", "one"), row("b", "three")]
    const shared = shareById(prev, next)
    expect(shared[0]).toBe(prev[0])
    expect(shared[1]).not.toBe(prev[1])
    expect(shared).toEqual(next)
  })

  it("keeps row identity across a reorder", () => {
    const prev = [row("a", "one"), row("b", "two")]
    const shared = shareById(prev, [row("b", "two"), row("a", "one")])
    expect(shared).not.toBe(prev)
    expect(shared[0]).toBe(prev[1])
    expect(shared[1]).toBe(prev[0])
  })
})

describe("shareMap", () => {
  it("returns the previous map when keys and values are deep-equal", () => {
    const prev = new Map([["a", { ids: ["x"] }]])
    expect(shareMap(prev, new Map([["a", { ids: ["x"] }]]))).toBe(prev)
  })

  it("returns the next map when a value, a key or the size differs", () => {
    const prev = new Map([["a", { ids: ["x"] }]])
    const changedValue = new Map([["a", { ids: ["y"] }]])
    const changedKey = new Map([["b", { ids: ["x"] }]])
    const grown = new Map([
      ["a", { ids: ["x"] }],
      ["b", { ids: ["x"] }],
    ])
    expect([shareMap(prev, changedValue), shareMap(prev, changedKey), shareMap(prev, grown)]).toEqual([
      changedValue,
      changedKey,
      grown,
    ])
    expect(shareMap(prev, changedValue)).not.toBe(prev)
  })
})

describe("createStableSelect", () => {
  const pick = (entry: { stream: { id: string; messageCount: number } }) => ({ stream: { id: entry.stream.id } })

  it("returns the slice it held while the picked fields are unchanged", () => {
    const select = createStableSelect(pick)
    const first = select({ stream: { id: "s", messageCount: 1 } })
    expect(select({ stream: { id: "s", messageCount: 2 } })).toBe(first)
  })

  it("returns a new slice once a picked field changes", () => {
    const select = createStableSelect(pick)
    const first = select({ stream: { id: "s", messageCount: 1 } })
    const second = select({ stream: { id: "t", messageCount: 1 } })
    expect(second).not.toBe(first)
    expect(second).toEqual({ stream: { id: "t" } })
  })
})
