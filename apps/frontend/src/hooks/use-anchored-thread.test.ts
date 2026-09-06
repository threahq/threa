import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { StreamTypes } from "@threahq/types"
import type { CachedStream } from "@/db"
import * as workspaceStore from "@/stores/workspace-store"
import { useAnchoredThreadId } from "./use-anchored-thread"

function thread(id: string, parentStreamId: string, anchor: Partial<CachedStream>): CachedStream {
  return { id, workspaceId: "ws_1", type: StreamTypes.THREAD, parentStreamId, ...anchor } as CachedStream
}

function seed(streams: CachedStream[]) {
  vi.spyOn(workspaceStore, "useWorkspaceStreamsRaw").mockReturnValue(streams)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useAnchoredThreadId", () => {
  it("finds the thread anchored on a card event", () => {
    seed([thread("stream_thread", "stream_host", { parentAnchorId: "event_card" })])
    const { result } = renderHook(() => useAnchoredThreadId("ws_1", "stream_host", "event_card"))
    expect(result.current).toBe("stream_thread")
  })

  it("falls back to the legacy message anchor on rows cached before parentAnchorId", () => {
    seed([thread("stream_thread", "stream_host", { parentMessageId: "msg_1" })])
    const { result } = renderHook(() => useAnchoredThreadId("ws_1", "stream_host", "msg_1"))
    expect(result.current).toBe("stream_thread")
  })

  it("is null when no thread carries the anchor, when the parent differs, and when the stream is not a thread", () => {
    seed([
      thread("stream_other_anchor", "stream_host", { parentAnchorId: "event_other" }),
      thread("stream_other_parent", "stream_elsewhere", { parentAnchorId: "event_card" }),
      {
        id: "stream_channel",
        workspaceId: "ws_1",
        type: StreamTypes.CHANNEL,
        parentStreamId: "stream_host",
        parentAnchorId: "event_card",
      } as CachedStream,
    ])
    const { result } = renderHook(() => useAnchoredThreadId("ws_1", "stream_host", "event_card"))
    expect(result.current).toBeNull()
  })

  it("is null without a parent stream or an anchor", () => {
    seed([thread("stream_thread", "stream_host", { parentAnchorId: "event_card" })])
    expect(renderHook(() => useAnchoredThreadId("ws_1", null, "event_card")).result.current).toBeNull()
    expect(renderHook(() => useAnchoredThreadId("ws_1", "stream_host", null)).result.current).toBeNull()
  })
})
