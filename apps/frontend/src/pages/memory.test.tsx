import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, userEvent } from "@/test"
import { MemoryPage } from "./memory"
import { SidebarProvider } from "@/contexts"
import * as hooksModule from "@/hooks"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useMobileModule from "@/hooks/use-mobile"
import * as relativeTimeModule from "@/components/relative-time"

const mockUseMemoSearch = vi.fn()
const mockUseMemoDetail = vi.fn()
const mockUseWorkspaceStreams = vi.fn()
const mockUseIsMobile = vi.fn()

const stubMutation = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false }

function renderPage(initialEntry = "/w/ws_1/memory?memo=memo_1") {
  return render(
    <SidebarProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/w/:workspaceId/memory" element={<MemoryPage />} />
        </Routes>
      </MemoryRouter>
    </SidebarProvider>
  )
}

// Long, unbreakable strings that would otherwise push Radix ScrollArea's
// display:table wrapper past the viewport. These shouldn't cause horizontal
// overflow because the memory page relies on [overflow-wrap:anywhere] to
// collapse min-content for long URLs and hashes.
const LONG_UNBREAKABLE_TITLE =
  "https://example.com/a/very/long/unbreakable/path/that/absolutely/will/not/fit/in/a/narrow/sidebar/viewport/without/wrapping/characters"
const LONG_UNBREAKABLE_ABSTRACT =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

function buildMemo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "memo_1",
    workspaceId: "ws_1",
    memoType: "message",
    sourceMessageId: "msg_1",
    sourceConversationId: null,
    title: "Launch decision",
    abstract: "Approved launch plan",
    keyPoints: [],
    sourceMessageIds: ["msg_1"],
    participantIds: ["user_1"],
    knowledgeType: "decision",
    tags: [],
    parentMemoId: null,
    status: "active",
    version: 1,
    revisionReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  }
}

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(hooksModule, "useMemoSearch").mockImplementation(
      (...args) => mockUseMemoSearch(...args) as ReturnType<typeof hooksModule.useMemoSearch>
    )
    vi.spyOn(hooksModule, "useMemoDetail").mockImplementation(
      (...args) => mockUseMemoDetail(...args) as ReturnType<typeof hooksModule.useMemoDetail>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockImplementation(
      (...args) => mockUseWorkspaceStreams(...args) as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
    )
    vi.spyOn(useMobileModule, "useIsMobile").mockImplementation(() => mockUseIsMobile())
    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation(() => <span>just now</span>)
    vi.spyOn(hooksModule, "useUpdateMemo").mockReturnValue(
      stubMutation as unknown as ReturnType<typeof hooksModule.useUpdateMemo>
    )
    vi.spyOn(hooksModule, "useArchiveMemo").mockReturnValue(
      stubMutation as unknown as ReturnType<typeof hooksModule.useArchiveMemo>
    )
    vi.spyOn(hooksModule, "useUnarchiveMemo").mockReturnValue(
      stubMutation as unknown as ReturnType<typeof hooksModule.useUnarchiveMemo>
    )
    vi.spyOn(hooksModule, "useDeleteMemo").mockReturnValue(
      stubMutation as unknown as ReturnType<typeof hooksModule.useDeleteMemo>
    )

    mockUseWorkspaceStreams.mockReset()
    mockUseMemoSearch.mockReset()
    mockUseMemoDetail.mockReset()
    mockUseIsMobile.mockReset()

    mockUseWorkspaceStreams.mockReturnValue([])
    // Default to desktop layout; individual tests opt into mobile.
    mockUseIsMobile.mockReturnValue(false)
  })

  it("never offers an aside in the stream filter (memory is off there)", async () => {
    mockUseMemoSearch.mockReturnValue({ data: { results: [] }, isFetching: false, refetch: vi.fn() })
    mockUseMemoDetail.mockReturnValue({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() })
    mockUseWorkspaceStreams.mockReturnValue([
      { id: "stream_general", type: "channel", slug: "general", displayName: "General", archivedAt: null },
      { id: "stream_aside", type: "aside", slug: null, displayName: "churn number sanity-check", archivedAt: null },
    ])
    renderPage("/w/ws_1/memory")

    await userEvent.click(screen.getByText("All streams"))
    expect(await screen.findByRole("option", { name: "#general" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "churn number sanity-check" })).toBeNull()
  })

  it("manually refreshes the memo list and selected memo", async () => {
    const refetchSearch = vi.fn().mockResolvedValue(undefined)
    const refetchDetail = vi.fn().mockResolvedValue(undefined)

    mockUseMemoSearch.mockReturnValue({
      data: {
        results: [
          {
            memo: {
              id: "memo_1",
              workspaceId: "ws_1",
              memoType: "message",
              sourceMessageId: "msg_1",
              sourceConversationId: null,
              title: "Launch decision",
              abstract: "Approved launch plan",
              keyPoints: [],
              sourceMessageIds: ["msg_1"],
              participantIds: ["user_1"],
              knowledgeType: "decision",
              tags: [],
              parentMemoId: null,
              status: "active",
              version: 1,
              revisionReason: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              archivedAt: null,
            },
            distance: 0,
            sourceStream: null,
            rootStream: null,
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchSearch,
    })

    mockUseMemoDetail.mockReturnValue({
      data: {
        memo: {
          memo: {
            id: "memo_1",
            workspaceId: "ws_1",
            memoType: "message",
            sourceMessageId: "msg_1",
            sourceConversationId: null,
            title: "Launch decision",
            abstract: "Approved launch plan",
            keyPoints: [],
            sourceMessageIds: ["msg_1"],
            participantIds: ["user_1"],
            knowledgeType: "decision",
            tags: [],
            parentMemoId: null,
            status: "active",
            version: 1,
            revisionReason: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archivedAt: null,
          },
          distance: 0,
          sourceStream: null,
          rootStream: null,
          sourceMessages: [],
        },
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchDetail,
    })

    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }))

    expect(refetchSearch).toHaveBeenCalledTimes(1)
    expect(refetchDetail).toHaveBeenCalledTimes(1)
  })

  // Regression guard for memory view overflow: long unbreakable strings (URLs,
  // hashes) must not be able to push the Radix ScrollArea's display:table
  // wrapper past the viewport width. This is achieved via inherited
  // [overflow-wrap:anywhere] which collapses min-content calculations, plus
  // min-w-0 on every flex path that holds user content.
  describe("overflow safety", () => {
    it("renders memo list cards inside an overflow-wrap:anywhere container so long titles can't blow out the sidebar", () => {
      mockUseMemoSearch.mockReturnValue({
        data: {
          results: [
            {
              memo: buildMemo({
                id: "memo_long",
                title: LONG_UNBREAKABLE_TITLE,
                abstract: LONG_UNBREAKABLE_ABSTRACT,
              }),
              distance: 0,
              sourceStream: null,
              rootStream: null,
            },
          ],
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      mockUseMemoDetail.mockReturnValue({
        data: null,
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      renderPage("/w/ws_1/memory")

      const title = screen.getByText(LONG_UNBREAKABLE_TITLE)
      const card = title.closest("a")
      expect(card).not.toBeNull()
      expect(card?.className).toContain("[overflow-wrap:anywhere]")
      expect(card?.className).toContain("overflow-hidden")

      // The title itself must be shrinkable in its flex parent so line-clamp
      // can actually clip rather than forcing the card wider.
      expect(title.className).toContain("min-w-0")
      expect(title.className).toContain("line-clamp-2")
    })

    it("renders memo detail with overflow-wrap:anywhere so long content wraps inside the viewport", () => {
      mockUseMemoSearch.mockReturnValue({
        data: {
          results: [
            {
              memo: buildMemo({ id: "memo_1", title: "Pick me" }),
              distance: 0,
              sourceStream: null,
              rootStream: null,
            },
          ],
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      mockUseMemoDetail.mockReturnValue({
        data: {
          memo: {
            memo: buildMemo({
              id: "memo_1",
              title: LONG_UNBREAKABLE_TITLE,
              abstract: LONG_UNBREAKABLE_ABSTRACT,
              keyPoints: [LONG_UNBREAKABLE_ABSTRACT],
              tags: [LONG_UNBREAKABLE_ABSTRACT],
            }),
            distance: 0,
            sourceStream: { id: "stream_1", name: LONG_UNBREAKABLE_TITLE, type: "channel" },
            rootStream: null,
            sourceMessages: [
              {
                id: "msg_1",
                streamId: "stream_1",
                streamName: LONG_UNBREAKABLE_TITLE,
                authorId: "user_1",
                authorType: "user" as const,
                authorName: "Alice",
                content: `Look at this URL: ${LONG_UNBREAKABLE_TITLE}`,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      renderPage("/w/ws_1/memory?memo=memo_1")

      // The detail root should have overflow-wrap:anywhere so all nested text
      // (title, abstract, key points, source messages, markdown) inherits it.
      const detailTitle = screen.getAllByText(LONG_UNBREAKABLE_TITLE)[0]
      // Walk up to the memo detail root wrapper
      let current: HTMLElement | null = detailTitle
      let foundOverflowWrap = false
      while (current) {
        if (current.className?.includes?.("[overflow-wrap:anywhere]")) {
          foundOverflowWrap = true
          break
        }
        current = current.parentElement
      }
      expect(foundOverflowWrap).toBe(true)
    })

    it("keeps source message headers from overflowing when stream names and author names are long", () => {
      mockUseMemoSearch.mockReturnValue({
        data: {
          results: [
            {
              memo: buildMemo({ id: "memo_1", title: "Pick me" }),
              distance: 0,
              sourceStream: null,
              rootStream: null,
            },
          ],
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      mockUseMemoDetail.mockReturnValue({
        data: {
          memo: {
            memo: buildMemo({ id: "memo_1" }),
            distance: 0,
            sourceStream: null,
            rootStream: null,
            sourceMessages: [
              {
                id: "msg_1",
                streamId: "stream_1",
                streamName: LONG_UNBREAKABLE_TITLE,
                authorId: "user_1",
                authorType: "user" as const,
                authorName: LONG_UNBREAKABLE_ABSTRACT,
                content: "Short content",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      renderPage("/w/ws_1/memory?memo=memo_1")

      // Author name must be truncatable in the flex header (not shrink-0)
      const authorSpan = screen.getByText(LONG_UNBREAKABLE_ABSTRACT)
      expect(authorSpan.className).toContain("min-w-0")
      expect(authorSpan.className).toContain("truncate")
      expect(authorSpan.className).not.toContain("shrink-0")

      // Stream name link must be truncatable
      const streamLink = screen.getAllByText(LONG_UNBREAKABLE_TITLE)[0]
      expect(streamLink.className).toContain("min-w-0")
      expect(streamLink.className).toContain("truncate")
    })
  })

  // Regression guard for desktop detail pane scroll. Between the mobile
  // breakpoint (640px) and lg (1024px) the content wrapper is a flex-col
  // with two flex-1 siblings (list + detail), and Radix ScrollArea's
  // `h-full` viewport height chain is brittle in that layout. The desktop
  // detail pane uses a plain div with `flex-1 min-h-0 overflow-y-auto` for
  // unambiguous native scrolling.
  describe("desktop detail pane scroll", () => {
    it("renders the desktop detail pane as a scrollable flex-1 div", () => {
      mockUseIsMobile.mockReturnValue(false)

      mockUseMemoSearch.mockReturnValue({
        data: {
          results: [
            {
              memo: buildMemo({ id: "memo_1", title: "Launch decision" }),
              distance: 0,
              sourceStream: null,
              rootStream: null,
            },
          ],
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      mockUseMemoDetail.mockReturnValue({
        data: {
          memo: {
            memo: buildMemo({ id: "memo_1", title: "Launch decision" }),
            distance: 0,
            sourceStream: null,
            rootStream: null,
            sourceMessages: [],
          },
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      renderPage("/w/ws_1/memory?memo=memo_1")

      // Walk up from the h2 title to find the scroll container. The detail
      // pane wraps the title in a <main> which is the direct child of the
      // scroll div.
      const detailTitle = screen.getByRole("heading", { level: 2, name: "Launch decision" })
      const mainEl = detailTitle.closest("main")
      expect(mainEl).not.toBeNull()
      const scrollContainer = mainEl?.parentElement
      expect(scrollContainer).not.toBeNull()
      expect(scrollContainer?.className).toContain("flex-1")
      expect(scrollContainer?.className).toContain("min-h-0")
      expect(scrollContainer?.className).toContain("overflow-y-auto")
    })
  })

  // Regression guard for mobile memo drawer scroll. The drawer uses Vaul
  // inside a flex-col DrawerContent with max-h-[85dvh], so the content body
  // must use `flex-1 min-h-0 overflow-y-auto` to actually claim space and
  // scroll — otherwise tall memos get clipped and the user can't see
  // Context/Provenance/Source sections. Also needs `data-vaul-no-drag` so
  // Vaul doesn't intercept touch scrolls as drawer-close gestures.
  describe("mobile drawer scroll", () => {
    it("renders the mobile detail drawer with a scrollable flex-1 body", () => {
      mockUseIsMobile.mockReturnValue(true)

      mockUseMemoSearch.mockReturnValue({
        data: {
          results: [
            {
              memo: buildMemo({ id: "memo_1", title: "Launch decision" }),
              distance: 0,
              sourceStream: null,
              rootStream: null,
            },
          ],
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      mockUseMemoDetail.mockReturnValue({
        data: {
          memo: {
            memo: buildMemo({ id: "memo_1", title: "Launch decision" }),
            distance: 0,
            sourceStream: null,
            rootStream: null,
            sourceMessages: [],
          },
        },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      })

      renderPage("/w/ws_1/memory?memo=memo_1")

      // The drawer renders MemoDetailContent with the title as an <h2>; the
      // sidebar list renders each result's title as an <h3>. Scope to level=2
      // so we're unambiguously inside the drawer body.
      const detailTitle = screen.getByRole("heading", { level: 2, name: "Launch decision" })
      let scrollContainer: HTMLElement | null = detailTitle.parentElement
      while (scrollContainer && !scrollContainer.hasAttribute("data-vaul-no-drag")) {
        scrollContainer = scrollContainer.parentElement
      }
      expect(scrollContainer).not.toBeNull()
      expect(scrollContainer?.className).toContain("flex-1")
      expect(scrollContainer?.className).toContain("min-h-0")
      expect(scrollContainer?.className).toContain("overflow-y-auto")
    })
  })
})
