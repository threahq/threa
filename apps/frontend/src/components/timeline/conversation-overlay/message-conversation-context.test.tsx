import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { MessageConversationProvider, useMessageConversationId } from "./message-conversation-context"

function wrapperFor(map: ReadonlyMap<string, string>) {
  return ({ children }: { children: ReactNode }) => (
    <MessageConversationProvider conversationIdByMessageId={map}>{children}</MessageConversationProvider>
  )
}

describe("useMessageConversationId", () => {
  it("returns the primary conversation id for a known message", () => {
    const map = new Map([["msg_1", "conv_a"]])
    const { result } = renderHook(() => useMessageConversationId("msg_1"), { wrapper: wrapperFor(map) })
    expect(result.current).toBe("conv_a")
  })

  it("returns null for a message with no known conversation", () => {
    const map = new Map([["msg_1", "conv_a"]])
    const { result } = renderHook(() => useMessageConversationId("msg_other"), { wrapper: wrapperFor(map) })
    expect(result.current).toBeNull()
  })

  it("returns null with no provider (in-stream surfaces without the map)", () => {
    const { result } = renderHook(() => useMessageConversationId("msg_1"))
    expect(result.current).toBeNull()
  })
})
