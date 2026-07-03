import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type ConversationService } from "@/contexts"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real store-hook read path
import { clearAllCachedData, db } from "@/db"
import type { RenderableMessage } from "@/components/message/message-item"
import { useConversationReadController } from "./conversation-read-context"

const WS = "ws_1"
const CONV = "conv_1"
const ROOT = "stream_root"
const THREAD = "stream_thread"
const ME = "usr_me"
const OTHER = "usr_other"

const markRead = vi.fn<ConversationService["markRead"]>()
const markUnread = vi.fn<ConversationService["markUnread"]>()

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ServicesProvider, {
        services: { conversations: { markRead, markUnread } as unknown as ConversationService },
        children,
      })
    )
  }
}

function msg(overrides: Partial<RenderableMessage> & Pick<RenderableMessage, "id">): RenderableMessage {
  return {
    streamId: ROOT,
    authorId: OTHER,
    authorType: "user",
    contentMarkdown: "body",
    reactions: {},
    createdAt: "2026-06-22T12:00:00.000Z",
    ...overrides,
  }
}

async function seedReadState(overlay: Record<string, string[]> = {}) {
  await db.unreadState.put({
    id: WS,
    workspaceId: WS,
    unreadCounts: { [ROOT]: 1 },
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    unreadActivities: [],
    latestOrdinals: { [ROOT]: 5 },
    readMessageIds: overlay,
    mutedStreamIds: [],
    _cachedAt: Date.now(),
  })
  // Root membership: watermark at sequence 3, read-through timestamp T0.
  await db.streamMemberships.put({
    id: `${WS}:${ROOT}`,
    workspaceId: WS,
    streamId: ROOT,
    memberId: "member_me",
    notificationLevel: "everything",
    lastReadEventId: "evt_3",
    lastReadSequence: "3",
    lastReadAt: "2026-06-22T12:00:00.000Z",
    joinedAt: "2026-06-01T00:00:00.000Z",
    _cachedAt: Date.now(),
  })
}

beforeEach(async () => {
  markRead.mockReset()
  markUnread.mockReset()
  await clearAllCachedData()
})

afterEach(() => vi.restoreAllMocks())

describe("useConversationReadController", () => {
  it("derives per-row read state against the stream watermark", async () => {
    await seedReadState()
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })

    // Strictly past the watermark sequence (3) → unread.
    await waitFor(() =>
      expect(result.current.value.state(ROOT, "m_reply", "5", "2026-06-22T12:00:00.000Z")).toBe("unread")
    )
    // At/before the watermark sequence → read.
    expect(result.current.value.state(ROOT, "m_open", "1", "2026-06-22T12:00:00.000Z")).toBe("read")
  })

  it("treats an overlay-read row as effectively read even past the watermark", async () => {
    await seedReadState({ [ROOT]: ["m_reply"] })
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })

    await waitFor(() =>
      expect(result.current.value.state(ROOT, "m_reply", "5", "2026-06-22T12:00:00.000Z")).toBe("read")
    )
  })

  it("falls back to the root read-through time for a non-member thread leg", async () => {
    await seedReadState()
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })
    // A thread with no membership row: compare createdAt to the root's lastReadAt (T0).
    await waitFor(() =>
      expect(result.current.value.state(THREAD, "t_old", undefined, "2026-06-22T11:00:00.000Z")).toBe("read")
    )
    expect(result.current.value.state(THREAD, "t_new", undefined, "2026-06-22T13:00:00.000Z")).toBe("unread")
  })

  it("reports the card unread when a non-own member message is effectively unread, excluding own rows", async () => {
    await seedReadState()
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })

    const own = msg({ id: "m_own", authorId: ME, sequence: "5" })
    const other = msg({ id: "m_reply", authorId: OTHER, sequence: "5" })
    await waitFor(() => expect(result.current.hasUnread([other])).toBe(true))
    // The viewer's own unread-sequence row must not light the dot.
    expect(result.current.hasUnread([own])).toBe(false)
  })

  it("marks read through a message via the client and clears the card unread once the overlay snapshot applies", async () => {
    await seedReadState()
    markRead.mockResolvedValue({
      streams: [
        {
          streamId: ROOT,
          readMessageIds: ["m_reply"],
          lastReadEventId: "evt_3",
          lastReadSequence: "3",
          lastReadOrdinal: 4,
        },
      ],
    })
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })
    const reply = msg({ id: "m_reply", authorId: OTHER, sequence: "5" })

    await waitFor(() => expect(result.current.hasUnread([reply])).toBe(true))

    result.current.value.markReadUpToHere("m_reply")
    expect(markRead).toHaveBeenCalledWith(WS, CONV, "m_reply")

    // The absolute snapshot lands in the overlay (IDB), so the row is now
    // effectively read and the card unread clears live.
    await waitFor(() => expect(result.current.hasUnread([reply])).toBe(false))
    expect(result.current.value.state(ROOT, "m_reply", "5", reply.createdAt)).toBe("read")
  })

  it("marks unread from a message via the client", async () => {
    await seedReadState({ [ROOT]: ["m_reply"] })
    markUnread.mockResolvedValue({
      streams: [
        { streamId: ROOT, readMessageIds: [], lastReadEventId: "evt_3", lastReadSequence: "3", lastReadOrdinal: 4 },
      ],
    })
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })
    const reply = msg({ id: "m_reply", authorId: OTHER, sequence: "5" })

    // Seeded overlay makes it read; mark-unread is offered.
    await waitFor(() => expect(result.current.value.state(ROOT, "m_reply", "5", reply.createdAt)).toBe("read"))
    result.current.value.markUnread("m_reply")
    expect(markUnread).toHaveBeenCalledWith(WS, CONV, "m_reply")
  })
})
