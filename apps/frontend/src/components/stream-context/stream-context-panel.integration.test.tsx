import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, Fragment } from "react"
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
import * as streamContextListModule from "@/components/stream-context/stream-context-list"
import * as storeModule from "@/stores/stream-context-store"
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

function renderPanel(options: { flag?: "on" | "off"; entry?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap(WS), {
    featureFlags: { workspace: { streamContextIndex: options.flag ?? "on" }, user: {} },
  })
  queryClient.setQueryData(delegationKeys.stream(WS, STREAM), { delegations: [] })
  const onJumpToMessage = vi.fn()
  const onOpenThread = vi.fn()
  render(
    <MemoryRouter initialEntries={[options.entry ?? "/s"]}>
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
  // `virtua` renders zero rows under jsdom's zero-height, no-op-ResizeObserver
  // layout, so swap the panel's virtualization seam for a passthrough that
  // renders every child — these tests exercise the real rows; the windowing
  // itself is verified in a browser. Same swap board.test.tsx makes (INV-48).
  vi.spyOn(streamContextListModule, "StreamContextList").mockImplementation(({ children }) =>
    createElement(Fragment, null, children)
  )
  observerCallbacks = []
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: IntersectionObserverCallback
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb
        observerCallbacks.push(cb)
      }
      observe() {}
      // A disconnected observer must stop firing, or a re-render's stale
      // callback pages a second time and clobbers the real page.
      disconnect() {
        observerCallbacks = observerCallbacks.filter((cb) => cb !== this.cb)
      }
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

    // Counts are category-independent server-side, but they ride the feed's
    // first page and that query is keyed on the category — so selecting a chip
    // must not drop the chips back to the local IDB tally while the new page
    // loads. Without the held counts this reads "1" (the cached row) mid-flight.
    expect(screen.getByRole("button", { name: /^Links/ })).toHaveTextContent("9")
    expect(screen.getByRole("button", { name: /^Memories/ })).toHaveTextContent("4")
  })

  it("keeps server counts across a chip change while the new page is in flight", async () => {
    await db.streamContextItems.bulkPut([
      cachedRow(serverItem({ category: "link", refId: "https://a.example", detail: { url: "https://a.example" } })),
    ])
    let resolveSecond: (value: ListStreamContextResponse) => void = () => {}
    vi.spyOn(streamContextApi, "list")
      .mockResolvedValueOnce(listResponse({ counts: { ...EMPTY_COUNTS, link: 240, memo: 37 } }))
      .mockImplementationOnce(
        () =>
          new Promise<ListStreamContextResponse>((resolve) => {
            resolveSecond = resolve
          })
      )

    renderPanel()
    expect(await screen.findByRole("button", { name: /^Links/ })).toHaveTextContent("240")

    // The second page never resolves, so this pins what the chips read while a
    // category query is still in flight — the moment the flip-flop happened.
    await userEvent.click(screen.getByRole("button", { name: /^Memories/ }))
    await waitFor(() => expect(streamContextApi.list).toHaveBeenCalledTimes(2))
    expect(screen.getByRole("button", { name: /^Links/ })).toHaveTextContent("240")
    expect(screen.getByRole("button", { name: /^Memories/ })).toHaveTextContent("37")

    resolveSecond(listResponse({ counts: { ...EMPTY_COUNTS, link: 240, memo: 37 } }))
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

  it("filters by the artifact's own text, not the message it came from", async () => {
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
    const search = await screen.findByLabelText("Search in this stream")

    // The artifact's own title matches, so the group survives and expands to
    // every occurrence — the count and the expansion agree.
    await userEvent.type(search, "Filtered")
    await userEvent.click(await screen.findByRole("button", { name: /Shared 2 times/ }))
    expect(await screen.findByText("quarterly plan")).toBeInTheDocument()
    expect(screen.getByText("old draft")).toBeInTheDocument()

    // A term that appears only in one source message's snippet matches nothing:
    // every artifact of a message shares that snippet, so matching it made a
    // message carrying five links match all five for a term naming only one.
    await userEvent.clear(search)
    await userEvent.type(search, "quarterly")
    await waitFor(() => expect(screen.queryByText("Filtered")).not.toBeInTheDocument())
  })

  it("jumps a delegation row to its card, which lives in an event and not a message", async () => {
    // Delegations are created by a tool call, not by posting a message, so the
    // row's only deep-link target is the `delegation:created` event. `?m=`
    // resolves an event id as readily as a message id.
    await db.streamContextItems.put(
      cachedRow(
        serverItem({
          category: "delegation",
          refKind: "delegation",
          refId: "task_1",
          sourceMessageId: null,
          anchorEventId: "event_delegation_1",
          detail: { title: "Ship the thing", status: "open" },
        })
      )
    )
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse({ counts: null }))

    const { onJumpToMessage } = renderPanel()

    await userEvent.click(await screen.findByRole("button", { name: /Go to delegation/ }))
    expect(onJumpToMessage).toHaveBeenCalledWith("event_delegation_1")
  })

  it("jumps the list to a picked date, landing on the nearest earlier day", async () => {
    const scrollToIndex = vi.fn()
    vi.spyOn(streamContextListModule, "StreamContextList").mockImplementation(({ children, listRef }) => {
      if (listRef) (listRef as { current: unknown }).current = { scrollToIndex }
      return createElement(Fragment, null, children)
    })
    // Newest-first: [marker 20th, row, marker 12th, row, marker 2nd, row].
    await db.streamContextItems.bulkPut([
      cachedRow(
        serverItem({ category: "link", refId: "https://newest.example", occurredAt: "2026-07-20T10:00:00.000Z" })
      ),
      cachedRow(
        serverItem({ category: "link", refId: "https://target.example", occurredAt: "2026-07-12T10:00:00.000Z" })
      ),
      cachedRow(
        serverItem({ category: "link", refId: "https://oldest.example", occurredAt: "2026-07-02T10:00:00.000Z" })
      ),
    ])
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse({ counts: null }))

    renderPanel()
    await userEvent.click((await screen.findAllByRole("button", { name: /Jump to a date/ }))[0]!)
    await userEvent.click(await screen.findByText("Jump to a specific date…"))
    await userEvent.click(await screen.findByText("12"))

    // The 12th's marker sits at flat index 2 — past the 20th's marker and its
    // one row. Landing on the marker, not the row, so the header reads the day.
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "start" })
  })

  it("pages into unloaded history to reach a jump target, then lands on it", async () => {
    const scrollToIndex = vi.fn()
    vi.spyOn(streamContextListModule, "StreamContextList").mockImplementation(({ children, listRef }) => {
      if (listRef) (listRef as { current: unknown }).current = { scrollToIndex }
      return createElement(Fragment, null, children)
    })
    // Only the newest day is cached; the 12th arrives with the jump's page.
    const older = serverItem({
      category: "link",
      refId: "https://older.example",
      occurredAt: "2026-07-12T10:00:00.000Z",
    })
    await db.streamContextItems.put(
      cachedRow(
        serverItem({ category: "link", refId: "https://newest.example", occurredAt: "2026-07-20T10:00:00.000Z" })
      )
    )
    // The jump's page is held open, so the assertions below can distinguish
    // "waited for the page" from "read IDB before it landed".
    let releasePage: (value: ListStreamContextResponse) => void = () => {}
    vi.spyOn(streamContextApi, "list")
      .mockResolvedValueOnce(listResponse({ counts: null, nextCursor: "c1" }))
      .mockImplementationOnce(
        () =>
          new Promise<ListStreamContextResponse>((resolve) => {
            releasePage = resolve
          })
      )

    renderPanel()
    await userEvent.click((await screen.findAllByRole("button", { name: /Jump to a date/ }))[0]!)
    await userEvent.click(await screen.findByText("Jump to a specific date…"))
    await userEvent.click(await screen.findByText("12"))

    // Still in flight: nothing to land on yet. If `fetchNextPage` resolved
    // before the page landed, the loop would have burned its budget against
    // stale IDB and given up here instead of waiting.
    expect(scrollToIndex).not.toHaveBeenCalled()

    releasePage(listResponse({ items: [older], counts: null }))

    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "start" }))
  })

  it("lands on the oldest day when the picked date is older than the whole stream", async () => {
    const scrollToIndex = vi.fn()
    vi.spyOn(streamContextListModule, "StreamContextList").mockImplementation(({ children, listRef }) => {
      if (listRef) (listRef as { current: unknown }).current = { scrollToIndex }
      return createElement(Fragment, null, children)
    })
    // [marker 20th, row, marker 18th, row] — nothing anywhere near the 2nd.
    await db.streamContextItems.bulkPut([
      cachedRow(
        serverItem({ category: "link", refId: "https://newest.example", occurredAt: "2026-07-20T10:00:00.000Z" })
      ),
      cachedRow(
        serverItem({ category: "link", refId: "https://oldest.example", occurredAt: "2026-07-18T10:00:00.000Z" })
      ),
    ])
    // One page of history, then the end. `hasNextPage` on the render-time
    // snapshot stays true for the whole loop, so only the fetch's own result
    // can stop it before it burns all MAX_JUMP_PAGES iterations.
    const readRows = vi.spyOn(storeModule, "readStreamContextRows")
    vi.spyOn(streamContextApi, "list")
      .mockResolvedValueOnce(listResponse({ counts: null, nextCursor: "c1" }))
      .mockResolvedValue(listResponse({ counts: null }))

    renderPanel()
    await screen.findAllByRole("button", { name: /Jump to a date/ })
    readRows.mockClear()

    await userEvent.click((await screen.findAllByRole("button", { name: /Jump to a date/ }))[0]!)
    await userEvent.click(await screen.findByText("Jump to a specific date…"))
    // By label, not text: with two rows a count chip also renders "2".
    await userEvent.click(await screen.findByRole("button", { name: /July 2nd/ }))

    // Travels as far back as the stream goes — the 18th's marker at flat index
    // 2 — instead of refusing because the 2nd itself holds nothing.
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(2, { align: "start" }))
    // One page fetched, one re-read. The bound is MAX_JUMP_PAGES (10), so a
    // loop trusting the stale snapshot re-reads ten times to reach the same
    // end of history.
    expect(readRows).toHaveBeenCalledTimes(1)
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

  it("surfaces an out-of-scope filter instead of forwarding it, and offers only the supported kinds", async () => {
    const list = vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse())

    renderPanel()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    await userEvent.type(screen.getByLabelText("Search in this stream"), "in:#general foo")

    expect(await screen.findByText(/in: is not supported here/)).toBeInTheDocument()
    await waitFor(() => expect(list.mock.calls.at(-1)?.[2]).toMatchObject({ q: "foo" }))
    for (const call of list.mock.calls) expect(call[2]).not.toHaveProperty("in")

    await userEvent.click(screen.getByLabelText("Add search filter"))
    const options = await screen.findAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("From user"),
      expect.stringContaining("After date"),
      expect.stringContaining("Before date"),
    ])
  })

  it("falls back to All when a ?context= deep link names a category the server has none of", async () => {
    await db.streamContextItems.put(
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://a.example",
          detail: { url: "https://a.example", title: "Alpha" },
        })
      )
    )
    const list = vi
      .spyOn(streamContextApi, "list")
      .mockResolvedValue(listResponse({ counts: { ...EMPTY_COUNTS, link: 1 } }))

    renderPanel({ entry: "/s?context=memo" })

    expect(await screen.findByText("Alpha")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true")
    await waitFor(() => expect(list.mock.calls.at(-1)?.[2]).toMatchObject({ category: undefined }))
  })

  it("counts the fallback chips over the searched set while the list is category-narrowed", async () => {
    await db.streamContextItems.bulkPut([
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://alpha.example",
          detail: { url: "https://alpha.example", title: "Alpha report" },
        })
      ),
      cachedRow(
        serverItem({
          category: "link",
          refId: "https://zulu.example",
          detail: { url: "https://zulu.example", title: "Zulu memo" },
        })
      ),
      cachedRow(
        serverItem({
          category: "memo",
          refId: "memo_1",
          refKind: "memo",
          detail: { title: "Alpha decision", knowledgeType: "decision" },
        })
      ),
    ])
    // No server counts (offline / first paint), so the chips fall back to the
    // local tally.
    vi.spyOn(streamContextApi, "list").mockResolvedValue(listResponse({ counts: null }))

    renderPanel()
    await screen.findByText("Alpha report")

    await userEvent.click(screen.getByRole("button", { name: /^Memories/ }))
    await userEvent.type(screen.getByLabelText("Search in this stream"), "alpha")

    // "Zulu memo" is out of the search, so the Links chip must not still say 2.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Links/ })).toHaveTextContent("1"))
    expect(screen.getByRole("button", { name: /^Memories/ })).toHaveTextContent("1")
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
