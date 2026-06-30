import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useConversationMembershipHeal } from "./use-conversation-membership-heal"

describe("useConversationMembershipHeal", () => {
  it("refetches once when the newest own message is unmapped, then not again after it maps", () => {
    const refetch = vi.fn()
    const props = {
      enabled: true,
      latestOwnMessageId: "msg_1",
      conversationIdByMessageId: new Map<string, string>(),
      refetch,
    }
    const { rerender } = renderHook((p) => useConversationMembershipHeal(p), { initialProps: props })

    // Unmapped → one heal refetch.
    expect(refetch).toHaveBeenCalledTimes(1)

    // Still unmapped, same message id, re-render → ref guard prevents a second.
    rerender({ ...props, conversationIdByMessageId: new Map<string, string>() })
    expect(refetch).toHaveBeenCalledTimes(1)

    // Message becomes mapped → no further refetch.
    rerender({ ...props, conversationIdByMessageId: new Map([["msg_1", "conv_a"]]) })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("re-arms for a newer own message", () => {
    const refetch = vi.fn()
    const { rerender } = renderHook((p) => useConversationMembershipHeal(p), {
      initialProps: {
        enabled: true,
        latestOwnMessageId: "msg_1" as string | null,
        conversationIdByMessageId: new Map([["msg_1", "conv_a"]]) as ReadonlyMap<string, string>,
        refetch,
      },
    })
    // msg_1 already mapped → no refetch.
    expect(refetch).toHaveBeenCalledTimes(0)

    // A newer own message arrives unmapped → one refetch for it.
    rerender({
      enabled: true,
      latestOwnMessageId: "msg_2",
      conversationIdByMessageId: new Map([["msg_1", "conv_a"]]),
      refetch,
    })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("does nothing when disabled or there is no own message", () => {
    const refetch = vi.fn()
    const { rerender } = renderHook((p) => useConversationMembershipHeal(p), {
      initialProps: {
        enabled: false,
        latestOwnMessageId: "msg_1" as string | null,
        conversationIdByMessageId: new Map<string, string>() as ReadonlyMap<string, string>,
        refetch,
      },
    })
    expect(refetch).toHaveBeenCalledTimes(0)

    rerender({
      enabled: true,
      latestOwnMessageId: null,
      conversationIdByMessageId: new Map<string, string>(),
      refetch,
    })
    expect(refetch).toHaveBeenCalledTimes(0)
  })
})
