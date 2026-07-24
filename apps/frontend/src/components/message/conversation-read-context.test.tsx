import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type ConversationService } from "@/contexts"
import type { ReadStateSnapshot } from "@/hooks/use-unread-counts"
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

async function seedReadState(
  overlay: Record<string, string[]> = {},
  unreadCounts: Record<string, number> = { [ROOT]: 1 }
) {
  await db.unreadState.put({
    id: WS,
    workspaceId: WS,
    unreadCounts,
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    unreadActivities: [],
    latestOrdinals: { [ROOT]: 5 },
    readMessageIds: overlay,
    mutedStreamIds: [],
    _cachedAt: Date.now(),
  })
  // Root membership (participation only).
  await db.streamMemberships.put({
    id: `${WS}:${ROOT}`,
    workspaceId: WS,
    streamId: ROOT,
    memberId: "member_me",
    notificationLevel: "everything",
    joinedAt: "2026-06-01T00:00:00.000Z",
    _cachedAt: Date.now(),
  })
  // Root read frontier: watermark at sequence 3, read-through timestamp T0.
  await db.streamReadState.put({
    id: `${WS}:${ROOT}`,
    workspaceId: WS,
    streamId: ROOT,
    lastReadEventId: "evt_3",
    lastReadSequence: "3",
    lastReadAt: "2026-06-22T12:00:00.000Z",
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

  it("treats a stream with zero effective unread as fully read despite a stale sequence frontier", async () => {
    // Mark-all-read advances counts to 0 without a per-stream sequence payload,
    // so the membership's lastReadSequence (3) goes stale. The count-0
    // short-circuit must win over the sequence comparison — a row at sequence 5
    // would otherwise re-derive as unread (phantom card dot).
    await seedReadState({}, { [ROOT]: 0 })
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })

    await waitFor(() =>
      expect(result.current.value.state(ROOT, "m_reply", "5", "2026-06-22T13:00:00.000Z")).toBe("read")
    )
    expect(result.current.hasUnread([msg({ id: "m_reply", sequence: "5" })])).toBe(false)
  })

  it("a non-member thread leg resolves through its OWN standalone frontier (lazy-persisted read-state row)", async () => {
    await seedReadState()
    // The leg's standalone frontier (persisted by the per-stream bootstrap on
    // open) — watermark at sequence 2. No membership row exists for the leg.
    await db.streamReadState.put({
      id: `${WS}:${THREAD}`,
      workspaceId: WS,
      streamId: THREAD,
      lastReadEventId: "evt_t2",
      lastReadSequence: "2",
      lastReadAt: "2026-06-22T12:00:00.000Z",
      _cachedAt: Date.now(),
    })
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })

    await waitFor(() =>
      expect(result.current.value.state(THREAD, "t_new", "5", "2026-06-22T13:00:00.000Z")).toBe("unread")
    )
    expect(result.current.value.state(THREAD, "t_old", "1", "2026-06-22T11:00:00.000Z")).toBe("read")
  })

  it("a resolved never-read leg (null-watermark sentinel) reads every sequenced row as unread", async () => {
    await seedReadState()
    await db.streamReadState.put({
      id: `${WS}:${THREAD}`,
      workspaceId: WS,
      streamId: THREAD,
      lastReadEventId: null,
      lastReadSequence: null,
      lastReadAt: null,
      _cachedAt: Date.now(),
    })
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })

    // Frontier before the first message: any sequenced row sits above it.
    await waitFor(() =>
      expect(result.current.value.state(THREAD, "t_first", "1", "2026-06-22T11:00:00.000Z")).toBe("unread")
    )
    expect(result.current.hasUnread([msg({ id: "t_first", streamId: THREAD, sequence: "1" })])).toBe(true)
  })

  it("an unresolved leg is ungated — the root last_read_at approximation is gone", async () => {
    await seedReadState()
    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })

    // No frontier for the leg (never opened): NOT approximated against the
    // root's read-through time — ungated until its own frontier resolves.
    await waitFor(() =>
      expect(result.current.value.state(THREAD, "t_old", undefined, "2026-06-22T11:00:00.000Z")).toBe("ungated")
    )
    expect(result.current.value.state(THREAD, "t_new", "5", "2026-06-22T13:00:00.000Z")).toBe("ungated")
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

  it("a delayed mark-read response cannot erase an explicit unread that landed after the request departed", async () => {
    await seedReadState()
    let resolveMarkRead!: (value: { streams: ReadStateSnapshot[] }) => void
    markRead.mockReturnValue(new Promise<{ streams: ReadStateSnapshot[] }>((resolve) => (resolveMarkRead = resolve)))

    const { result } = renderHook(() => useConversationReadController(WS, CONV, ROOT, ME), { wrapper: wrapper() })
    const reply = msg({ id: "m_reply", authorId: OTHER, sequence: "5" })
    await waitFor(() => expect(result.current.hasUnread([reply])).toBe(true))

    result.current.value.markReadUpToHere("m_reply")
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(WS, CONV, "m_reply"))

    // An explicit conversation unread lands while the read is in flight: its
    // echo regresses the frontier to the never-read position and stamps the
    // touched time on the standalone row.
    await db.streamReadState.put({
      id: `${WS}:${ROOT}`,
      workspaceId: WS,
      streamId: ROOT,
      lastReadEventId: null,
      lastReadSequence: null,
      lastReadAt: new Date().toISOString(),
      _cachedAt: Date.now(),
    })

    // The stale read response finally resolves with its absolute snapshot.
    await act(async () => {
      resolveMarkRead({
        streams: [
          {
            streamId: ROOT,
            readMessageIds: ["m_reply"],
            lastReadEventId: "evt_5",
            lastReadSequence: "5",
            lastReadOrdinal: 5,
          },
        ],
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    // The explicit unread survives: no overlay SET, no frontier restore.
    const row = await db.streamReadState.get(`${WS}:${ROOT}`)
    expect(row?.lastReadEventId).toBeNull()
    const unreadState = await db.unreadState.get(WS)
    expect(unreadState?.readMessageIds?.[ROOT]).toBeUndefined()
    await waitFor(() => expect(result.current.value.state(ROOT, "m_reply", "5", reply.createdAt)).toBe("unread"))
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
