import { describe, it, expect } from "bun:test"
import { createVisibleStreamRegistry } from "./visible-streams"

const flushMicrotasks = () => Promise.resolve()

describe("createVisibleStreamRegistry", () => {
  it("publishes the deduped, sorted union of registered ids", async () => {
    const published: string[][] = []
    const registry = createVisibleStreamRegistry((ids) => published.push(ids))

    registry.register(["stream_b", "stream_a"])
    registry.register(["stream_a"])
    await flushMicrotasks()

    expect(published).toEqual([["stream_a", "stream_b"]])
    expect(registry.snapshot()).toEqual(["stream_a", "stream_b"])
  })

  it("keeps an id visible until every registration for it is released", async () => {
    const published: string[][] = []
    const registry = createVisibleStreamRegistry((ids) => published.push(ids))

    const releaseFirst = registry.register(["stream_a"])
    const releaseSecond = registry.register(["stream_a", "stream_b"])
    await flushMicrotasks()

    releaseFirst()
    await flushMicrotasks()
    expect(registry.snapshot()).toEqual(["stream_a", "stream_b"])

    releaseSecond()
    await flushMicrotasks()
    expect(registry.snapshot()).toEqual([])
    expect(published.at(-1)).toEqual([])
  })

  it("coalesces a same-tick swap into one publish and ignores double release", async () => {
    const published: string[][] = []
    const registry = createVisibleStreamRegistry((ids) => published.push(ids))

    const release = registry.register(["stream_a"])
    await flushMicrotasks()
    published.length = 0

    // Panel swap: unregister + register within one render pass.
    release()
    release() // double release must not underflow another registration's count
    registry.register(["stream_b"])
    await flushMicrotasks()

    expect(published).toEqual([["stream_b"]])
  })
})
