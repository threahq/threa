import { afterEach, describe, expect, it, vi } from "vitest"
import {
  consumeConversationReplyOpen,
  requestConversationReplyOpen,
  resetConversationReplyOpenStoreCache,
  subscribeConversationReplyOpen,
} from "./conversation-reply-open-store"

afterEach(() => {
  resetConversationReplyOpenStoreCache()
  vi.useRealTimers()
})

describe("conversation reply-open store", () => {
  it("returns false when nothing is queued for the conversation", () => {
    expect(consumeConversationReplyOpen("ws_1", "conv_a")).toBe(false)
  })

  it("returns true once and clears the entry on consume", () => {
    requestConversationReplyOpen("ws_1", "conv_a")
    expect(consumeConversationReplyOpen("ws_1", "conv_a")).toBe(true)
    expect(consumeConversationReplyOpen("ws_1", "conv_a")).toBe(false)
  })

  it("queues independently per conversation", () => {
    requestConversationReplyOpen("ws_1", "conv_a")
    expect(consumeConversationReplyOpen("ws_1", "conv_b")).toBe(false)
    expect(consumeConversationReplyOpen("ws_1", "conv_a")).toBe(true)
  })

  it("evicts entries whose TTL has expired", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"))
    requestConversationReplyOpen("ws_1", "conv_a")

    vi.setSystemTime(new Date("2026-04-23T12:01:00Z")) // 60s later, past 30s TTL
    expect(consumeConversationReplyOpen("ws_1", "conv_a")).toBe(false)
  })

  it("notifies a subscriber when a request is queued for the matching conversation", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeConversationReplyOpen("ws_1", "conv_a", listener)

    requestConversationReplyOpen("ws_1", "conv_a")
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    requestConversationReplyOpen("ws_1", "conv_a")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("scopes notifications by conversation — listeners on other conversations are not called", () => {
    const onA = vi.fn()
    const onB = vi.fn()
    subscribeConversationReplyOpen("ws_1", "conv_a", onA)
    subscribeConversationReplyOpen("ws_1", "conv_b", onB)

    requestConversationReplyOpen("ws_1", "conv_a")
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()
  })

  it("should keep a request invisible to another workspace when both hold the same conversation id", () => {
    const onB = vi.fn()
    subscribeConversationReplyOpen("ws_b", "conv_shared", onB)

    requestConversationReplyOpen("ws_a", "conv_shared")

    expect({
      consumedByB: consumeConversationReplyOpen("ws_b", "conv_shared"),
      listenerBCalls: onB.mock.calls.length,
      consumedByA: consumeConversationReplyOpen("ws_a", "conv_shared"),
    }).toEqual({ consumedByB: false, listenerBCalls: 0, consumedByA: true })
  })
})
