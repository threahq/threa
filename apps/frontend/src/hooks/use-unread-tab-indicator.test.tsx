import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { StreamTypes } from "@threa/types"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { useUnreadTabIndicator } from "./use-unread-tab-indicator"

const WS = "ws_1"

function setup(unreadCounts: Record<string, number>, mutedStreamIds: string[] = []) {
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue({
    unreadCounts,
    mutedStreamIds,
  } as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
    { id: "stream_channel", type: StreamTypes.CHANNEL },
    { id: "stream_aside", type: StreamTypes.ASIDE },
    { id: "stream_aside_thread", type: StreamTypes.THREAD, rootStreamId: "stream_aside" },
  ] as never)
}

beforeEach(() => {
  document.title = "Threa"
})

afterEach(() => vi.restoreAllMocks())

describe("useUnreadTabIndicator", () => {
  it("counts unmuted stream unread into the tab title", () => {
    setup({ stream_channel: 2 })
    renderHook(() => useUnreadTabIndicator(WS))
    expect(document.title).toBe("(2) | Threa")
  })

  it("never counts an aside's unread, nor a thread's inside it — a pull surface lights no badge", () => {
    setup({ stream_channel: 2, stream_aside: 5, stream_aside_thread: 4 })
    renderHook(() => useUnreadTabIndicator(WS))
    expect(document.title).toBe("(2) | Threa")
  })

  it("shows no count when only asides (or muted streams) are unread", () => {
    setup({ stream_aside: 5, stream_muted: 3 }, ["stream_muted"])
    renderHook(() => useUnreadTabIndicator(WS))
    expect(document.title).toBe("Threa")
  })
})
