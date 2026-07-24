import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { SharedMessagesProvider, useSharedMessageHydration } from "./context"

describe("SharedMessagesProvider", () => {
  it("returns null when no provider wraps the hook", () => {
    const { result } = renderHook(() => useSharedMessageHydration("msg_1"))
    expect(result.current).toBeNull()
  })

  it("returns null when the provider has no map", () => {
    const { result } = renderHook(() => useSharedMessageHydration("msg_1"), {
      wrapper: ({ children }) => <SharedMessagesProvider map={null}>{children}</SharedMessagesProvider>,
    })
    expect(result.current).toBeNull()
  })

  it("returns the hydrated payload keyed by messageId", () => {
    const ok = {
      type: "sharedMessage" as const,
      state: "ok" as const,
      messageId: "msg_1",
      streamId: "stream_src",
      authorId: "usr_1",
      authorType: "user",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hi",
      editedAt: null,
      createdAt: "2026-04-23T10:00:00Z",
      attachments: [],
    }
    const { result } = renderHook(() => useSharedMessageHydration("msg_1"), {
      wrapper: ({ children }) => <SharedMessagesProvider map={{ msg_1: ok }}>{children}</SharedMessagesProvider>,
    })
    expect(result.current).toEqual(ok)
  })

  it("returns null for a messageId missing from the map", () => {
    const { result } = renderHook(() => useSharedMessageHydration("msg_missing"), {
      wrapper: ({ children }) => (
        <SharedMessagesProvider
          map={{ msg_other: { type: "sharedMessage", state: "missing", messageId: "msg_other" } }}
        >
          {children}
        </SharedMessagesProvider>
      ),
    })
    expect(result.current).toBeNull()
  })
})
