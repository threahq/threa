import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { sharedMessageSlotKey, type SlotMap } from "@threa/types"
import { SlotsProvider, useSharedMessageSlot } from "./context"

const okSlot = {
  type: "sharedMessage" as const,
  state: "ok" as const,
  messageId: "msg_1",
  streamId: "stream_src",
  authorId: "usr_1",
  authorName: null,
  authorType: "user",
  contentJson: { type: "doc", content: [] },
  contentMarkdown: "hi",
  editedAt: null,
  createdAt: "2026-04-23T10:00:00Z",
  attachments: [],
}

describe("SlotsProvider", () => {
  it("returns null when no provider wraps the hook", () => {
    const { result } = renderHook(() => useSharedMessageSlot("msg_1"))
    expect(result.current).toBeNull()
  })

  it("returns null when the provider has no map", () => {
    const { result } = renderHook(() => useSharedMessageSlot("msg_1"), {
      wrapper: ({ children }) => <SlotsProvider map={null}>{children}</SlotsProvider>,
    })
    expect(result.current).toBeNull()
  })

  it("derives the namespaced shared key from a bare messageId", () => {
    const map: SlotMap = { [sharedMessageSlotKey("msg_1")]: okSlot }
    const { result } = renderHook(() => useSharedMessageSlot("msg_1"), {
      wrapper: ({ children }) => <SlotsProvider map={map}>{children}</SlotsProvider>,
    })
    expect(result.current).toEqual(okSlot)
  })

  it("does not match a bare messageId key — only the canonical namespaced key", () => {
    // A map still keyed by bare ids (the slot store never produces one) must not
    // resolve: the lookup only consults `shared:<messageId>`.
    const { result } = renderHook(() => useSharedMessageSlot("msg_1"), {
      wrapper: ({ children }) => <SlotsProvider map={{ msg_1: okSlot }}>{children}</SlotsProvider>,
    })
    expect(result.current).toBeNull()
  })

  it("returns null for a messageId missing from the map", () => {
    const map: SlotMap = {
      [sharedMessageSlotKey("msg_other")]: { type: "sharedMessage", state: "missing", messageId: "msg_other" },
    }
    const { result } = renderHook(() => useSharedMessageSlot("msg_missing"), {
      wrapper: ({ children }) => <SlotsProvider map={map}>{children}</SlotsProvider>,
    })
    expect(result.current).toBeNull()
  })
})
