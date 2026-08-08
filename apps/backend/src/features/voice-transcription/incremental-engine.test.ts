import { describe, expect, it } from "bun:test"
import { IncrementalVoiceEngine, scalarLength, splitUnicodeFinal } from "./incremental-engine"

const doc = { type: "doc" } as const

describe("IncrementalVoiceEngine", () => {
  it("rolls at four finals and 1,200 Unicode scalars", () => {
    const engine = new IncrementalVoiceEngine()
    for (const text of ["one", "two", "three", "four", "five"]) engine.appendFinal(text)
    expect(engine.windows.map((window) => ({ finals: window.finalCount, state: window.state }))).toEqual([
      { finals: 4, state: "sealed" },
      { finals: 1, state: "open" },
    ])

    const bounded = new IncrementalVoiceEngine()
    bounded.appendFinal("😀".repeat(1_200))
    bounded.appendFinal("x")
    expect(bounded.windows.map((window) => window.rawCharCount)).toEqual([1_200, 1])
  })

  it("splits oversized Unicode without loss, reordering, or surrogate damage", () => {
    const input = `${"😀".repeat(1_199)} hello ${"å".repeat(1_205)}`
    const pieces = splitUnicodeFinal(input, 1_200)
    expect(pieces.join("")).toBe(input)
    expect(pieces.every((piece) => scalarLength(piece) <= 1_200)).toBe(true)
  })

  it("accepts exact sealed-window results after a later window opens but rejects stale current results", () => {
    const engine = new IncrementalVoiceEngine()
    for (const text of ["a", "b", "c", "d"]) engine.appendFinal(text)
    const sealed = engine.activeWindow!
    engine.appendFinal("e")
    expect(
      engine.registerOperation({
        operationId: "old",
        sources: [{ chunkId: sealed.chunkId, throughRevision: sealed.latestRevision }],
        resultChunkId: sealed.chunkId,
        markdown: "old",
        contentJson: doc,
        rawMarkdown: "raw",
        rawContentJson: doc,
      })
    ).toBe(true)
    expect(engine.acknowledge("old", "applied")).toBe(true)

    const current = engine.activeWindow!
    const staleRevision = current.latestRevision
    engine.appendFinal("f")
    expect(
      engine.registerOperation({
        operationId: "stale",
        sources: [{ chunkId: current.chunkId, throughRevision: staleRevision }],
        resultChunkId: current.chunkId,
        markdown: "stale",
        contentJson: doc,
        rawMarkdown: "raw",
        rawContentJson: doc,
      })
    ).toBe(false)
  })

  it("atomically collapses two acknowledged sources to the editor result id", () => {
    const engine = new IncrementalVoiceEngine()
    for (const value of ["a", "b", "c", "d", "e"]) engine.appendFinal(value)
    const [predecessor, current] = engine.windows
    for (const window of [predecessor!, current!]) {
      engine.registerOperation({
        operationId: `accept-${window.chunkId}`,
        sources: [{ chunkId: window.chunkId, throughRevision: window.latestRevision }],
        resultChunkId: window.chunkId,
        markdown: engine.raw(window),
        contentJson: doc,
        rawMarkdown: engine.raw(window),
        rawContentJson: doc,
      })
      engine.acknowledge(`accept-${window.chunkId}`, "applied")
    }
    engine.registerOperation({
      operationId: "wide",
      sources: [
        { chunkId: predecessor!.chunkId, throughRevision: predecessor!.latestRevision },
        { chunkId: current!.chunkId, throughRevision: current!.latestRevision },
      ],
      resultChunkId: "collapsed",
      markdown: "combined",
      contentJson: doc,
      rawMarkdown: "a b c d e",
      rawContentJson: doc,
    })
    expect(engine.acknowledge("wide", "applied")).toBe(true)
    expect(engine.windows.map((window) => ({ id: window.chunkId, accepted: window.accepted?.markdown }))).toEqual([
      { id: "collapsed", accepted: "combined" },
    ])
    expect(engine.exactCurrentAccepted()?.resultChunkId).toBe("collapsed")
    expect(engine.activeWindow!.state).toBe("sealed")
    expect(engine.maxMutableLength).toBe(9)

    const continuation = engine.appendFinal("later")[0]!
    expect(continuation.chunkId).not.toBe("collapsed")
    expect(continuation.afterChunkId).toBe("collapsed")
    expect(engine.windows.map((window) => window.logicalSpanCount)).toEqual([2, 1])
  })

  it("tracks every acknowledgement status including timeout without accepting it", () => {
    const engine = new IncrementalVoiceEngine()
    const delta = engine.appendFinal("raw")[0]!
    const statuses = ["stale", "locked", "missing", "non_contiguous", "invalid"] as const
    for (const status of statuses) {
      const operationId = `op-${status}`
      expect(
        engine.registerOperation({
          operationId,
          sources: [{ chunkId: delta.chunkId, throughRevision: delta.revision }],
          resultChunkId: delta.chunkId,
          markdown: "polished",
          contentJson: doc,
          rawMarkdown: "raw",
          rawContentJson: doc,
        })
      ).toBe(true)
      expect(engine.acknowledge(operationId, status)).toBe(false)
    }
    expect(
      engine.registerOperation({
        operationId: "op-timeout",
        sources: [{ chunkId: delta.chunkId, throughRevision: delta.revision }],
        resultChunkId: delta.chunkId,
        markdown: "polished",
        contentJson: doc,
        rawMarkdown: "raw",
        rawContentJson: doc,
      })
    ).toBe(true)
    expect(engine.rejectPending("op-timeout")).toBe(true)
    expect(engine.counters).toMatchObject({
      timeout: 1,
      stale: 1,
      locked: 1,
      missing: 1,
      non_contiguous: 1,
      invalid: 1,
      applied: 0,
    })
  })

  it("keeps acknowledged content plus a visible raw tail without treating a partial predecessor as exact", () => {
    const engine = new IncrementalVoiceEngine()
    const first = engine.appendFinal("raw")[0]!
    engine.registerOperation({
      operationId: "accepted-prefix",
      sources: [{ chunkId: first.chunkId, throughRevision: first.revision }],
      resultChunkId: first.chunkId,
      markdown: "Polished.",
      contentJson: doc,
      rawMarkdown: "raw",
      rawContentJson: doc,
    })
    expect(engine.acknowledge("accepted-prefix", "applied")).toBe(true)
    engine.appendFinal("visible tail")
    expect(engine.visibleMarkdown(engine.activeWindow!)).toBe("Polished. visible tail")
    expect(engine.exactCurrentAccepted()).toBeUndefined()
    engine.appendFinal("third")
    engine.appendFinal("fourth")
    const next = engine.appendFinal("new window")[0]!.window
    expect(engine.immediateAcceptedPredecessor(next)).toBeUndefined()
  })

  it("reuses only exact applied results and ignores duplicate or rejected acknowledgements", () => {
    const engine = new IncrementalVoiceEngine()
    const delta = engine.appendFinal("raw")[0]!
    expect(
      engine.registerOperation({
        operationId: "accepted",
        sources: [{ chunkId: delta.chunkId, throughRevision: delta.revision }],
        resultChunkId: delta.chunkId,
        markdown: "polished",
        contentJson: doc,
        rawMarkdown: "raw",
        rawContentJson: doc,
      })
    ).toBe(true)
    expect(engine.acknowledge("accepted", "locked")).toBe(false)
    expect(engine.acknowledge("accepted", "applied")).toBe(false)
    expect(engine.exactCurrentAccepted()).toBeUndefined()
  })
})
