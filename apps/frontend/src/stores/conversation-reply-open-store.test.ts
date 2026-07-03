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
    expect(consumeConversationReplyOpen("conv_a")).toBe(false)
  })

  it("returns true once and clears the entry on consume", () => {
    requestConversationReplyOpen("conv_a")
    expect(consumeConversationReplyOpen("conv_a")).toBe(true)
    expect(consumeConversationReplyOpen("conv_a")).toBe(false)
  })

  it("queues independently per conversation", () => {
    requestConversationReplyOpen("conv_a")
    expect(consumeConversationReplyOpen("conv_b")).toBe(false)
    expect(consumeConversationReplyOpen("conv_a")).toBe(true)
  })

  it("evicts entries whose TTL has expired", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"))
    requestConversationReplyOpen("conv_a")

    vi.setSystemTime(new Date("2026-04-23T12:01:00Z")) // 60s later, past 30s TTL
    expect(consumeConversationReplyOpen("conv_a")).toBe(false)
  })

  it("notifies a subscriber when a request is queued for the matching conversation", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeConversationReplyOpen("conv_a", listener)

    requestConversationReplyOpen("conv_a")
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    requestConversationReplyOpen("conv_a")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("scopes notifications by conversation — listeners on other conversations are not called", () => {
    const onA = vi.fn()
    const onB = vi.fn()
    subscribeConversationReplyOpen("conv_a", onA)
    subscribeConversationReplyOpen("conv_b", onB)

    requestConversationReplyOpen("conv_a")
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()
  })
})
