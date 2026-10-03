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
    expect(consumeShareHandoff("ws_1", "stream_a")).toBeNull()
  })

  it("returns the queued attrs and clears the entry on consume", () => {
    queueShareHandoff("ws_1", "stream_a", sampleAttrs)
    expect(consumeShareHandoff("ws_1", "stream_a")).toEqual(sampleAttrs)
    expect(consumeShareHandoff("ws_1", "stream_a")).toBeNull()
  })

  it("queues + consumes a decrypted E2E plaintext share on its own channel", () => {
    queuePlaintextShareHandoff("ws_1", "stream_a", "the secret plan", sampleAttrs)
    // The pointer channel is untouched by a plaintext queue.
    expect(consumeShareHandoff("ws_1", "stream_a")).toBeNull()
    expect(peekPlaintextShareHandoff("ws_1", "stream_a")).toMatchObject({
      markdown: "the secret plan",
      attrs: sampleAttrs,
    })
    expect(consumePlaintextShareHandoff("ws_1", "stream_a")).toMatchObject({
      markdown: "the secret plan",
      attrs: sampleAttrs,
    })
    expect(consumePlaintextShareHandoff("ws_1", "stream_a")).toBeNull()
  })

  it("keeps multiple handoffs queued while the destination composer prepares", () => {
    queueShareHandoff("ws_1", "stream_a", { ...sampleAttrs, messageId: "msg_1" })
    queueShareHandoff("ws_1", "stream_a", { ...sampleAttrs, messageId: "msg_2" })

    expect(consumeShareHandoff("ws_1", "stream_a")?.messageId).toBe("msg_1")
    expect(consumeShareHandoff("ws_1", "stream_a")?.messageId).toBe("msg_2")
    expect(consumeShareHandoff("ws_1", "stream_a")).toBeNull()
  })

  it("snapshots mixed handoffs in FIFO order and acknowledges only that batch", () => {
    queuePlaintextShareHandoff("ws_1", "stream_a", "first", { ...sampleAttrs, messageId: "msg_plain" })
    queueShareHandoff("ws_1", "stream_a", { ...sampleAttrs, messageId: "msg_pointer" })

    const batch = peekShareHandoffBatch("ws_1", "stream_a")!
    expect(batch.handoffs).toEqual([
      { kind: "plaintext", markdown: "first", attrs: { ...sampleAttrs, messageId: "msg_plain" } },
      { kind: "pointer", attrs: { ...sampleAttrs, messageId: "msg_pointer" } },
    ])
    expect(peekPlaintextShareHandoff("ws_1", "stream_a")?.markdown).toBe("first")

    queueShareHandoff("ws_1", "stream_a", { ...sampleAttrs, messageId: "msg_later" })
    acknowledgeShareHandoffBatch("ws_1", "stream_a", batch)

    expect(consumePlaintextShareHandoff("ws_1", "stream_a")).toBeNull()
    expect(consumeShareHandoff("ws_1", "stream_a")?.messageId).toBe("msg_later")
  })

  it("queues independently per target stream", () => {
    queueShareHandoff("ws_1", "stream_a", { ...sampleAttrs, messageId: "msg_a" })
    queueShareHandoff("ws_1", "stream_b", { ...sampleAttrs, messageId: "msg_b" })
    expect(consumeShareHandoff("ws_1", "stream_a")?.messageId).toBe("msg_a")
    expect(consumeShareHandoff("ws_1", "stream_b")?.messageId).toBe("msg_b")
  })

  it("evicts entries whose TTL has expired", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"))
    queueShareHandoff("ws_1", "stream_a", sampleAttrs)

    vi.setSystemTime(new Date("2026-04-23T12:10:00Z")) // 10 minutes later, past 5m TTL
    expect(consumeShareHandoff("ws_1", "stream_a")).toBeNull()
  })

  it("peek does not clear the entry", () => {
    queueShareHandoff("ws_1", "stream_a", sampleAttrs)
    expect(peekShareHandoff("ws_1", "stream_a")).toEqual(sampleAttrs)
    expect(peekShareHandoff("ws_1", "stream_a")).toEqual(sampleAttrs)
    expect(consumeShareHandoff("ws_1", "stream_a")).toEqual(sampleAttrs)
    expect(peekShareHandoff("ws_1", "stream_a")).toBeNull()
  })

  it("notifies subscribers when a share is queued for the matching stream", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeShareHandoff("ws_1", "stream_a", listener)

    queueShareHandoff("ws_1", "stream_a", sampleAttrs)
    expect(listener).toHaveBeenCalledTimes(1)

    queueShareHandoff("ws_1", "stream_a", { ...sampleAttrs, messageId: "msg_2" })
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    queueShareHandoff("ws_1", "stream_a", sampleAttrs)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("scopes notifications by stream — listeners on other streams are not called", () => {
    const onA = vi.fn()
    const onB = vi.fn()
    subscribeShareHandoff("ws_1", "stream_a", onA)
    subscribeShareHandoff("ws_1", "stream_b", onB)

    queueShareHandoff("ws_1", "stream_a", sampleAttrs)
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()
  })

  it("carries an aside hand-off on the same queue, in order, and acknowledges it with the rest", () => {
    const content = [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }]
    queueShareHandoff("ws_1", "stream_1", sampleAttrs)
    queueContentHandoff("ws_1", "stream_1", content)
    queuePlaintextShareHandoff("ws_1", "stream_1", "sealed body", { ...sampleAttrs, messageId: "msg_2" })

    const batch = peekShareHandoffBatch("ws_1", "stream_1")
    expect(batch?.handoffs).toEqual([
      { kind: "pointer", attrs: sampleAttrs },
      { kind: "content", content, attachments: [] },
      { kind: "plaintext", markdown: "sealed body", attrs: { ...sampleAttrs, messageId: "msg_2" } },
    ])

    acknowledgeShareHandoffBatch("ws_1", "stream_1", batch!)
    expect(peekShareHandoffBatch("ws_1", "stream_1")).toBeNull()
  })

  it("notifies a mounted composer with the content it now has to drain", () => {
    const content = [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }]
    const seen: unknown[] = []
    const unsubscribe = subscribeShareHandoff("ws_1", "stream_1", () =>
      seen.push(peekShareHandoffBatch("ws_1", "stream_1")?.handoffs)
    )
    queueContentHandoff("ws_1", "stream_1", content)
    expect(seen).toEqual([[{ kind: "content", content, attachments: [] }]])
    unsubscribe()
  })

  it("should keep a share queued for one workspace invisible to another when both target the same stream id", () => {
    const onB = vi.fn()
    subscribeShareHandoff("ws_b", "stream_1", onB)

    queueShareHandoff("ws_a", "stream_1", { ...sampleAttrs, messageId: "msg_a" })
    queuePlaintextShareHandoff("ws_a", "stream_1", "private to a", sampleAttrs)

    expect({
      pointerPeekB: peekShareHandoff("ws_b", "stream_1"),
      plaintextPeekB: peekPlaintextShareHandoff("ws_b", "stream_1"),
      batchPeekB: peekShareHandoffBatch("ws_b", "stream_1"),
      pointerConsumeB: consumeShareHandoff("ws_b", "stream_1"),
      plaintextConsumeB: consumePlaintextShareHandoff("ws_b", "stream_1"),
      listenerBCalls: onB.mock.calls.length,
    }).toEqual({
      pointerPeekB: null,
      plaintextPeekB: null,
      batchPeekB: null,
      pointerConsumeB: null,
      plaintextConsumeB: null,
      listenerBCalls: 0,
    })
    expect(peekShareHandoffBatch("ws_a", "stream_1")?.handoffs).toEqual([
      { kind: "pointer", attrs: { ...sampleAttrs, messageId: "msg_a" } },
      { kind: "plaintext", markdown: "private to a", attrs: sampleAttrs },
    ])
  })
})
