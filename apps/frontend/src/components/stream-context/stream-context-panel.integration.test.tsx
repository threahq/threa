import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
import { streamContextApi } from "@/api"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real panel read path
import { db, type CachedStreamContextItem } from "@/db"
import * as hooks from "@/hooks"
import * as connectionStatus from "@/components/layout/connection-status"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { delegationKeys } from "@/hooks/use-stream-delegations"
import { streamContextItemKey, type ListStreamContextResponse, type StreamContextItem } from "@threa/types"
import { StreamContextPanel } from "./stream-context-panel"

const WS = "ws_1"
const STREAM = "stream_root"
const THREAD = "stream_thread"

const EMPTY_COUNTS = { link: 0, media: 0, file: 0, memo: 0, delegation: 0, thread: 0 }

/** jsdom has no IntersectionObserver; capture the callbacks so a test can fire them. */
let observerCallbacks: IntersectionObserverCallback[] = []
function triggerSentinel() {
  for (const cb of observerCallbacks) {
    cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  }
}

function serverItem(
  overrides: Partial<Omit<StreamContextItem, "detail">> &
    Pick<StreamContextItem, "category" | "refId"> & { detail?: Record<string, unknown> }
) {
  const sourceMessageId = overrides.sourceMessageId ?? `msg_${overrides.refId}`
  return {
    key: streamContextItemKey({ category: overrides.category, refId: overrides.refId, sourceMessageId }),
    refKind: "url",
    groupKey: overrides.refId,
    streamId: STREAM,
    sourceMessageId,
    authorId: "usr_1",
    occurredAt: "2026-06-24T10:00:00.000Z",
    sequence: "1",
    snippet: "",
    occurrenceCount: 1,
    detail: {},
    ...overrides,
  } as unknown as StreamContextItem
}

function cachedRow(item: StreamContextItem, extra: Partial<CachedStreamContextItem> = {}): CachedStreamContextItem {
  return {
    ...item,
    workspaceId: WS,
    rootStreamId: STREAM,
    groupRef: `${item.category}:${item.groupKey}`,
    _cachedAt: Date.now(),
    ...extra,
  }
}

function listResponse(overrides: Partial<ListStreamContextResponse> = {}): ListStreamContextResponse {
  return { items: [], counts: { ...EMPTY_COUNTS }, nextCursor: null, mode: "index", ...overrides }
}

function renderPanel(options: { flag?: "on" | "off" } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap(WS), {
    featureFlags: { workspace: { streamContextIndex: options.flag ?? "on" }, user: {} },
  })
  queryClient.setQueryData(delegationKeys.stream(WS, STREAM), { delegations: [] })
  const onJumpToMessage = vi.fn()
  const onOpenThread = vi.fn()
  render(
    <MemoryRouter initialEntries={["/s"]}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <StreamContextPanel
            workspaceId={WS}
            streamId={STREAM}
            onClose={vi.fn()}
            onJumpToMessage={onJumpToMessage}
            onOpenThread={onOpenThread}
            onOpenMemo={vi.fn()}
            onOpenGallery={vi.fn()}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
  return { onJumpToMessage, onOpenThread }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  observerCallbacks = []
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        observerCallbacks.push(cb)
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return []
      }
    }
  )
  vi.spyOn(hooks, "useFormattedDate").mockReturnValue({
    formatRelative: () => "now",
  } as unknown as ReturnType<typeof hooks.useFormattedDate>)
  vi.spyOn(connectionStatus, "useIsOnline").mockReturnValue(true)
  await db.streamContextItems.clear()
  await db.events.clear()
  await db.streams.clear()
  await db.workspaceUsers.clear()
  await db.streams.put({ id: STREAM, workspaceId: WS, rootStreamId: null } as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("StreamContextPanel — flag off", () => {
  it("renders the derive path (no index search box)", async () => {
    await db.events.put({
      id: "evt_1",
      streamId: STREAM,
      eventType: "message_created",
      sequence: "1",
      _sequenceNum: 1,
      actorId: "usr_1",
      actorType: "user",
      createdAt: "2026-06-24T10:00:00.000Z",
      payload: {
        messageId: "msg_1",
        contentMarkdown: "see it",
        attachments: [{ id: "att_1", filename: "notes.pdf", mimeType: "application/pdf", sizeBytes: 10 }],
      },
      _cachedAt: Date.now(),
    } as never)
    const list = vi.spyOn(streamContextApi, "list")

    renderPanel({ flag: "off" })

    expect(await screen.findByText("notes.pdf")).toBeInTheDocument()
    expect(screen.queryByLabelText("Search in this stream")).not.toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
  })
})

describe("StreamContextPanel — flag on", () => {
  it("renders rows from IDB and appends the next page when the sentinel intersects", async () => {
    await db.streamContextItems.bulkPut([
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://a.example",
          detail: { url: "https://a.example", title: "Alpha" },
        })
      ),
    ])
    const page2 = serverItem({
      category: "link",
      refId: "https://b.example",
      occurredAt: "2026-06-23T10:00:00.000Z",
      detail: { url: "https://b.example", title: "Bravo" },
    })
    const list = vi
      .spyOn(streamContextApi, "list")
      .mockResolvedValueOnce(listResponse({ counts: { ...EMPTY_COUNTS, link: 2 }, nextCursor: "c1" }))
      .mockResolvedValueOnce(listResponse({ items: [page2], counts: null }))

    renderPanel()

    expect(await screen.findByText("Alpha")).toBeInTheDocument()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    triggerSentinel()
    expect(await screen.findByText("Bravo")).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1]?.[2]).toMatchObject({ cursor: "c1" })
  })

  it("takes chip counts from the server payload and filters by category", async () => {
    await db.streamContextItems.bulkPut([
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://a.example",
          detail: { url: "https://a.example", title: "Alpha" },
        })
      ),
      cachedRow(
        serverItem({
          category: "memo",
          refId: "memo_1",
          refKind: "memo",
          detail: { title: "Retention decision", knowledgeType: "decision" },
        })
      ),
    ])
    vi.spyOn(streamContextApi, "list").mockResolvedValue(
      listResponse({ counts: { ...EMPTY_COUNTS, link: 9, memo: 4 } })
    )

    renderPanel()

    const links = await screen.findByRole("button", { name: /^Links/ })
    expect(links).toHaveTextContent("9")
    expect(screen.getByRole("button", { name: /^Memories/ })).toHaveTextContent("4")

    await userEvent.click(screen.getByRole("button", { name: /^Memories/ }))
    expect(await screen.findByText("Retention decision")).toBeInTheDocument()
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument()
  })

  it("filters locally as you type, before the debounced server phase runs", async () => {
    await db.streamContextItems.bulkPut([
      cachedRow(
        serverItem({
          category: "file",
          refId: "att_1",
          refKind: "attachment",
          detail: { attachmentId: "att_1", filename: "budget.pdf", mimeType: "application/pdf", sizeBytes: 12 },
        })
      ),
      cachedRow(
        serverItem({
          category: "file",
          refId: "att_2",
          refKind: "attachment",
          detail: { attachmentId: "att_2", filename: "roadmap.pdf", mimeType: "application/pdf", sizeBytes: 12 },
        })
      ),
    ])
    const list = vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse())

    renderPanel()
    expect(await screen.findByText("budget.pdf")).toBeInTheDocument()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    await userEvent.type(screen.getByLabelText("Search in this stream"), "roadmap")

    await waitFor(() => expect(screen.queryByText("budget.pdf")).not.toBeInTheDocument())
    // The match is wrapped in <mark> by HighlightedText, so the label is split.
    expect(screen.getByText("roadmap", { selector: "mark" })).toBeInTheDocument()
    // Phase 1 only so far — the server phase is still inside its debounce.
    expect(list).toHaveBeenCalledTimes(1)
  })

  it("turns from:@user into a chip and narrows the list", async () => {
    await db.workspaceUsers.put({ id: "usr_2", workspaceId: WS, slug: "mara", name: "Mara" } as never)
    await db.streamContextItems.bulkPut([
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://mine.example",
          detail: { url: "https://mine.example", title: "Mine" },
        })
      ),
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://hers.example",
          authorId: "usr_2",
          detail: { url: "https://hers.example", title: "Hers" },
        })
      ),
    ])
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse())

    renderPanel()
    expect(await screen.findByText("Mine")).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("Search in this stream"), "from:@mara ")

    expect(await screen.findByLabelText("Remove filter @mara")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText("Mine")).not.toBeInTheDocument())
    expect(screen.getByText("Hers")).toBeInTheDocument()
  })

  it("expands a multi-occurrence row into its occurrences, each with its own jump", async () => {
    const collapsed = serverItem({
      category: "link",
      refId: "https://shared.example",
      sourceMessageId: "msg_b",
      occurrenceCount: 2,
      detail: { url: "https://shared.example", title: "Shared" },
    })
    await db.streamContextItems.put(cachedRow(collapsed))
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse({ counts: { ...EMPTY_COUNTS, link: 1 } }))
    const older = serverItem({
      category: "link",
      refId: "https://shared.example",
      sourceMessageId: "msg_a",
      occurredAt: "2026-06-20T10:00:00.000Z",
      snippet: "first share",
      detail: { url: "https://shared.example", title: "Shared" },
    })
    const occurrences = vi
      .spyOn(streamContextApi, "occurrences")
      .mockResolvedValue({ items: [collapsed, older], nextCursor: null })

    const { onJumpToMessage } = renderPanel()

    const expander = await screen.findByRole("button", { name: /Shared 2 times/ })
    await userEvent.click(expander)

    expect(await screen.findByText("first share")).toBeInTheDocument()
    expect(occurrences).toHaveBeenCalledWith(
      WS,
      STREAM,
      expect.objectContaining({ groupKey: "https://shared.example" })
    )

    await userEvent.click(screen.getByText("first share"))
    expect(onJumpToMessage).toHaveBeenCalledWith("msg_a")
  })

  it("collapses a group into one feed row, and expanding it does not duplicate the row", async () => {
    const collapsed = serverItem({
      category: "link",
      refId: "https://shared.example",
      sourceMessageId: "msg_b",
      occurrenceCount: 2,
      detail: { url: "https://shared.example", title: "Shared" },
    })
    const older = serverItem({
      category: "link",
      refId: "https://shared.example",
      sourceMessageId: "msg_a",
      occurredAt: "2026-06-20T10:00:00.000Z",
      snippet: "first share",
      detail: { url: "https://shared.example", title: "Shared" },
    })
    await db.streamContextItems.put(cachedRow(collapsed))
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse({ counts: null }))
    vi.spyOn(streamContextApi, "occurrences").mockResolvedValue({ items: [collapsed, older], nextCursor: null })

    renderPanel()

    await userEvent.click(await screen.findByRole("button", { name: /Shared 2 times/ }))
    expect(await screen.findByText("first share")).toBeInTheDocument()
    // The occurrence seed wrote both members into IDB; they must not re-enter the
    // feed as top-level rows.
    expect(screen.getAllByText("Shared")).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: /Shared 2 times/ })).toHaveLength(1)
  })

  it("collapses repeated local rows and counts the group once", async () => {
    const shared = {
      category: "link" as const,
      refId: "https://twice.example",
      detail: { url: "https://twice.example", title: "Twice" },
    }
    await db.streamContextItems.bulkPut([
      cachedRow(serverItem({ ...shared, sourceMessageId: "msg_a", occurredAt: "2026-06-20T10:00:00.000Z" }), {
        _status: "pending",
      }),
      cachedRow(serverItem({ ...shared, sourceMessageId: "msg_b" }), { _status: "pending" }),
    ])
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse({ counts: null }))

    renderPanel()

    expect(await screen.findByText("Twice")).toBeInTheDocument()
    expect(screen.getAllByText("Twice")).toHaveLength(1)
    expect(screen.getByRole("button", { name: /^Links/ })).toHaveTextContent("1")
  })

  it("applies the active text filter to an expanded group's occurrences", async () => {
    const shared = {
      category: "link" as const,
      refId: "https://filtered.example",
      occurrenceCount: 2,
      detail: { url: "https://filtered.example", title: "Filtered" },
    }
    const newer = serverItem({ ...shared, sourceMessageId: "msg_b", snippet: "quarterly plan" })
    const older = serverItem({
      ...shared,
      sourceMessageId: "msg_a",
      occurredAt: "2026-06-20T10:00:00.000Z",
      snippet: "old draft",
    })
    await db.streamContextItems.bulkPut([cachedRow(newer), cachedRow(older)])
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse({ counts: null }))
    vi.spyOn(streamContextApi, "occurrences").mockResolvedValue({ items: [newer, older], nextCursor: null })

    renderPanel()
    await userEvent.type(await screen.findByLabelText("Search in this stream"), "quarterly")

    await userEvent.click(await screen.findByRole("button", { name: /Shared 2 times/ }))
    expect(await screen.findByText("quarterly plan")).toBeInTheDocument()
    expect(screen.queryByText("old draft")).not.toBeInTheDocument()
  })

  it("does not offer expansion on a locally derived row (no server groupKey yet)", async () => {
    await db.streamContextItems.put(
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://local.example",
          occurrenceCount: 3,
          detail: { url: "https://local.example", title: "Local" },
        }),
        { _status: "pending" }
      )
    )
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse())

    renderPanel()

    expect(await screen.findByText("Local")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Shared/ })).not.toBeInTheDocument()
  })

  it("shows a thread-owned item's origin and opens the thread before jumping", async () => {
    await db.streamContextItems.put(
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://inthread.example",
          streamId: THREAD,
          sourceMessageId: "msg_t",
          detail: { url: "https://inthread.example", title: "InThread" },
        })
      )
    )
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse())

    const { onJumpToMessage, onOpenThread } = renderPanel()

    expect(await screen.findByText(/^in /)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Go to message" }))
    expect(onOpenThread).toHaveBeenCalledWith(THREAD)
    expect(onJumpToMessage).toHaveBeenCalledWith("msg_t")
  })

  it("falls back to the local path with a note when the stream is sealed", async () => {
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse({ counts: null, mode: "client" }))

    renderPanel()

    expect(await screen.findByText(/encrypted/i)).toBeInTheDocument()
    expect(screen.queryByLabelText("Search in this stream")).not.toBeInTheDocument()
  })

  it("takes the local path for a sealed stream even when the first page never answers", async () => {
    await db.streams.put({ id: STREAM, workspaceId: WS, rootStreamId: null, e2eEnabled: true } as never)
    await db.events.put({
      id: "evt_1",
      streamId: STREAM,
      eventType: "message_created",
      sequence: "1",
      _sequenceNum: 1,
      actorId: "usr_1",
      actorType: "user",
      createdAt: "2026-06-24T10:00:00.000Z",
      payload: {
        messageId: "msg_1",
        contentMarkdown: "see it",
        attachments: [{ id: "att_1", filename: "notes.pdf", mimeType: "application/pdf", sizeBytes: 10 }],
      },
      _cachedAt: Date.now(),
    } as never)
    vi.spyOn(connectionStatus, "useIsOnline").mockReturnValue(false)
    vi.spyOn(streamContextApi, "list").mockRejectedValue(new Error("offline"))

    renderPanel()

    expect(await screen.findByText("notes.pdf")).toBeInTheDocument()
    expect(await screen.findByText(/encrypted/i)).toBeInTheDocument()
  })

  it("renders the offline boundary when nothing at all is cached", async () => {
    vi.spyOn(connectionStatus, "useIsOnline").mockReturnValue(false)
    vi.spyOn(streamContextApi, "list").mockRejectedValue(new Error("offline"))

    renderPanel()

    expect(await screen.findByText(/Offline — showing what's cached/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing from this stream is cached/)).toBeInTheDocument()
  })

  it("renders an explicit offline boundary instead of a silent end-of-list", async () => {
    vi.spyOn(connectionStatus, "useIsOnline").mockReturnValue(false)
    await db.streamContextItems.put(
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://cached.example",
          detail: { url: "https://cached.example", title: "Cached" },
        })
      )
    )
    vi.spyOn(streamContextApi, "list").mockRejectedValue(new Error("offline"))

    renderPanel()

    expect(await screen.findByText("Cached")).toBeInTheDocument()
    const boundary = await screen.findByText(/Offline — showing what's cached/)
    expect(within(boundary.parentElement!).getByText(/reconnect/)).toBeInTheDocument()
  })
})
