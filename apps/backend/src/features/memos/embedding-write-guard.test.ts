import { describe, expect, it } from "bun:test"
import { writeEmbeddingWithSourceHashGuard, hashEmbeddingText } from "./embedding-write-guard"

interface GuardCalls {
  embedded: string[]
  written: { sourceHash: string; expectedSourceHash: string | null }[]
}

function guardFor(options: { texts: (string | null)[]; storedHashes: (string | null)[]; writeResults: number[] }) {
  const calls: GuardCalls = { embedded: [], written: [] }
  let read = 0
  let wrote = 0

  const run = () =>
    writeEmbeddingWithSourceHashGuard({
      subject: "conv_test",
      loadText: async () => options.texts[Math.min(read, options.texts.length - 1)] ?? null,
      readExpectedHash: async () => options.storedHashes[Math.min(read++, options.storedHashes.length - 1)] ?? null,
      embed: async (text) => {
        calls.embedded.push(text)
        return [1, 2, 3]
      },
      write: async (row) => {
        calls.written.push({ sourceHash: row.sourceHash, expectedSourceHash: row.expectedSourceHash })
        return options.writeResults[Math.min(wrote++, options.writeResults.length - 1)] ?? 0
      },
    })

  return { run, calls }
}

describe("writeEmbeddingWithSourceHashGuard", () => {
  it("embeds once and reports the write when the CAS lands", async () => {
    const { run, calls } = guardFor({ texts: ["hello"], storedHashes: [null], writeResults: [1] })

    expect(await run()).toBe("written")
    expect(calls).toEqual({
      embedded: ["hello"],
      written: [{ sourceHash: hashEmbeddingText("hello"), expectedSourceHash: null }],
    })
  })

  it("costs no model call when the stored hash already matches the text", async () => {
    const { run, calls } = guardFor({
      texts: ["hello"],
      storedHashes: [hashEmbeddingText("hello")],
      writeResults: [1],
    })

    expect(await run()).toBe("unchanged")
    expect(calls).toEqual({ embedded: [], written: [] })
  })

  it("reports missing text without embedding", async () => {
    const { run, calls } = guardFor({ texts: [null], storedHashes: [null], writeResults: [1] })

    expect(await run()).toBe("text-missing")
    expect(calls).toEqual({ embedded: [], written: [] })
  })

  it("reuses the embedding when it loses the race but the text has not moved", async () => {
    const { run, calls } = guardFor({
      texts: ["hello"],
      storedHashes: [null, "someone-elses-hash"],
      writeResults: [0, 1],
    })

    expect(await run()).toBe("written")
    expect(calls).toEqual({
      embedded: ["hello"],
      written: [
        { sourceHash: hashEmbeddingText("hello"), expectedSourceHash: null },
        { sourceHash: hashEmbeddingText("hello"), expectedSourceHash: "someone-elses-hash" },
      ],
    })
  })

  it("embeds again when the text moved under it", async () => {
    const { run, calls } = guardFor({
      texts: ["hello", "hello, again"],
      storedHashes: [null, "someone-elses-hash"],
      writeResults: [0, 1],
    })

    expect(await run()).toBe("written")
    expect(calls.embedded).toEqual(["hello", "hello, again"])
  })

  it("hands the job back to the queue after three lost writes", async () => {
    const { run, calls } = guardFor({ texts: ["hello"], storedHashes: [null], writeResults: [0] })

    await expect(run()).rejects.toThrow("Embedding for conv_test lost to a concurrent write 3 times")
    expect(calls.written.length).toBe(3)
  })
})
