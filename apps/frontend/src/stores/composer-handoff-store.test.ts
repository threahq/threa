import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetShareHandoffStoreForTesting,
  acknowledgeShareHandoffBatch,
  consumeShareHandoff,
  consumePlaintextShareHandoff,
  peekShareHandoff,
  peekPlaintextShareHandoff,
  peekShareHandoffBatch,
  queueShareHandoff,
  queuePlaintextShareHandoff,
  queueContentHandoff,
  subscribeShareHandoff,
} from "./composer-handoff-store"

const sampleAttrs = {
  messageId: "msg_1",
  streamId: "stream_src",
  authorName: "Alice",
  authorId: "usr_1",
  actorType: "user",
  version: 3,
  range: null,
}

afterEach(() => {
  __resetShareHandoffStoreForTesting()
  vi.useRealTimers()
})

describe("share handoff store", () => {
  it("returns null when nothing is queued for the stream", () => {
    expect(consumeShareHandoff("stream_a")).toBeNull()
  })

  it("returns the queued attrs and clears the entry on consume", () => {
    queueShareHandoff("stream_a", sampleAttrs)
    expect(consumeShareHandoff("stream_a")).toEqual(sampleAttrs)
    expect(consumeShareHandoff("stream_a")).toBeNull()
  })

  it("queues + consumes a decrypted E2E plaintext share on its own channel", () => {
    queuePlaintextShareHandoff("stream_a", "the secret plan", sampleAttrs)
    // The pointer channel is untouched by a plaintext queue.
    expect(consumeShareHandoff("stream_a")).toBeNull()
    expect(peekPlaintextShareHandoff("stream_a")).toMatchObject({ markdown: "the secret plan", attrs: sampleAttrs })
    expect(consumePlaintextShareHandoff("stream_a")).toMatchObject({ markdown: "the secret plan", attrs: sampleAttrs })
    expect(consumePlaintextShareHandoff("stream_a")).toBeNull()
  })

  it("keeps multiple handoffs queued while the destination composer prepares", () => {
    queueShareHandoff("stream_a", { ...sampleAttrs, messageId: "msg_1" })
    queueShareHandoff("stream_a", { ...sampleAttrs, messageId: "msg_2" })

    expect(consumeShareHandoff("stream_a")?.messageId).toBe("msg_1")
    expect(consumeShareHandoff("stream_a")?.messageId).toBe("msg_2")
    expect(consumeShareHandoff("stream_a")).toBeNull()
  })

  it("snapshots mixed handoffs in FIFO order and acknowledges only that batch", () => {
    queuePlaintextShareHandoff("stream_a", "first", { ...sampleAttrs, messageId: "msg_plain" })
    queueShareHandoff("stream_a", { ...sampleAttrs, messageId: "msg_pointer" })

    const batch = peekShareHandoffBatch("stream_a")!
    expect(batch.handoffs).toEqual([
      { kind: "plaintext", markdown: "first", attrs: { ...sampleAttrs, messageId: "msg_plain" } },
      { kind: "pointer", attrs: { ...sampleAttrs, messageId: "msg_pointer" } },
    ])
    expect(peekPlaintextShareHandoff("stream_a")?.markdown).toBe("first")

    queueShareHandoff("stream_a", { ...sampleAttrs, messageId: "msg_later" })
    acknowledgeShareHandoffBatch("stream_a", batch)

    expect(consumePlaintextShareHandoff("stream_a")).toBeNull()
    expect(consumeShareHandoff("stream_a")?.messageId).toBe("msg_later")
  })

  it("queues independently per target stream", () => {
    queueShareHandoff("stream_a", { ...sampleAttrs, messageId: "msg_a" })
    queueShareHandoff("stream_b", { ...sampleAttrs, messageId: "msg_b" })
    expect(consumeShareHandoff("stream_a")?.messageId).toBe("msg_a")
    expect(consumeShareHandoff("stream_b")?.messageId).toBe("msg_b")
  })

  it("evicts entries whose TTL has expired", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"))
    queueShareHandoff("stream_a", sampleAttrs)

    vi.setSystemTime(new Date("2026-04-23T12:10:00Z")) // 10 minutes later, past 5m TTL
    expect(consumeShareHandoff("stream_a")).toBeNull()
  })

  it("peek does not clear the entry", () => {
    queueShareHandoff("stream_a", sampleAttrs)
    expect(peekShareHandoff("stream_a")).toEqual(sampleAttrs)
    expect(peekShareHandoff("stream_a")).toEqual(sampleAttrs)
    expect(consumeShareHandoff("stream_a")).toEqual(sampleAttrs)
    expect(peekShareHandoff("stream_a")).toBeNull()
  })

  it("notifies subscribers when a share is queued for the matching stream", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeShareHandoff("stream_a", listener)

    queueShareHandoff("stream_a", sampleAttrs)
    expect(listener).toHaveBeenCalledTimes(1)

    queueShareHandoff("stream_a", { ...sampleAttrs, messageId: "msg_2" })
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    queueShareHandoff("stream_a", sampleAttrs)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("scopes notifications by stream — listeners on other streams are not called", () => {
    const onA = vi.fn()
    const onB = vi.fn()
    subscribeShareHandoff("stream_a", onA)
    subscribeShareHandoff("stream_b", onB)

    queueShareHandoff("stream_a", sampleAttrs)
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()
  })

  it("carries an aside hand-off on the same queue, in order, and acknowledges it with the rest", () => {
    const content = [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }]
    queueShareHandoff("stream_1", sampleAttrs)
    queueContentHandoff("stream_1", content)
    queuePlaintextShareHandoff("stream_1", "sealed body", { ...sampleAttrs, messageId: "msg_2" })

    const batch = peekShareHandoffBatch("stream_1")
    expect(batch?.handoffs).toEqual([
      { kind: "pointer", attrs: sampleAttrs },
      { kind: "content", content },
      { kind: "plaintext", markdown: "sealed body", attrs: { ...sampleAttrs, messageId: "msg_2" } },
    ])

    acknowledgeShareHandoffBatch("stream_1", batch!)
    expect(peekShareHandoffBatch("stream_1")).toBeNull()
  })

  it("notifies a mounted composer with the content it now has to drain", () => {
    const content = [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }]
    const seen: unknown[] = []
    const unsubscribe = subscribeShareHandoff("stream_1", () => seen.push(peekShareHandoffBatch("stream_1")?.handoffs))
    queueContentHandoff("stream_1", content)
    expect(seen).toEqual([[{ kind: "content", content }]])
    unsubscribe()
  })
})
