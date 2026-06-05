import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetShareHandoffStoreForTesting,
  consumeShareHandoff,
  consumePlaintextShareHandoff,
  peekShareHandoff,
  queueShareHandoff,
  queuePlaintextShareHandoff,
  subscribeShareHandoff,
} from "./share-handoff-store"

const sampleAttrs = {
  messageId: "msg_1",
  streamId: "stream_src",
  authorName: "Alice",
  authorId: "usr_1",
  actorType: "user",
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
    expect(consumePlaintextShareHandoff("stream_a")).toMatchObject({ markdown: "the secret plan", attrs: sampleAttrs })
    // Cleared after consume.
    expect(consumePlaintextShareHandoff("stream_a")).toBeNull()
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
})
