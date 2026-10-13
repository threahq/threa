import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, fireEvent, userEvent, waitFor } from "@/test"
import { AttachmentExplorer } from "./attachment-explorer"
import { ExplorerShell } from "./explorer-shell"
import * as attachmentsApiModule from "@/api/attachments"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as preferencesModule from "@/contexts/preferences-context"
import * as unreadCountsModule from "@/hooks/use-unread-counts"
import * as activityCountsModule from "@/hooks/use-activity-counts"
import * as useMobileModule from "@/hooks/use-mobile"

function makeItem(
  overrides: Partial<attachmentsApiModule.AttachmentSearchItem> = {}
): attachmentsApiModule.AttachmentSearchItem {
  return {
    id: "attach_a",
    workspaceId: "ws_1",
    streamId: "str_design",
    messageId: "msg_1",
    uploadedBy: "usr_1",
    filename: "logo.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    storageProvider: "s3",
    storagePath: "ws_1/attach_a/logo.png",
    processingStatus: "completed",
    safetyStatus: "clean",
    createdAt: new Date("2026-05-01T10:00:00.000Z").toISOString() as unknown as Date,
    extraction: null,
    streamSlug: "design",
    streamName: "Design",
    streamType: "channel",
    uploaderSlug: "mira",
    uploaderName: "Mira",
    referenceCount: 0,
    ...overrides,
  } as attachmentsApiModule.AttachmentSearchItem
}

function renderExplorer(initialEntry: string, element = <AttachmentExplorer workspaceId="ws_1" />) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  })
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/w/:workspaceId/*" element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(tree())
  return { ...view, rerender: () => view.rerender(tree()) }
}

describe("AttachmentExplorer", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue(undefined)
    vi.spyOn(unreadCountsModule, "useUnreadCounts").mockReturnValue({
      getUnreadCount: () => 0,
    } as unknown as ReturnType<typeof unreadCountsModule.useUnreadCounts>)
    vi.spyOn(activityCountsModule, "useActivityCounts").mockReturnValue({
      getMentionCount: () => 0,
      unreadActivityCount: 0,
    } as unknown as ReturnType<typeof activityCountsModule.useActivityCounts>)
    vi.spyOn(preferencesModule, "usePreferences").mockReturnValue({
      preferences: { dateFormat: "YYYY-MM-DD", timeFormat: "24h", timezone: "UTC" } as never,
    } as unknown as ReturnType<typeof preferencesModule.usePreferences>)
    vi.spyOn(attachmentsApiModule.attachmentsApi, "getDownloadUrl").mockResolvedValue("https://example.test/blob")
  })

  it("does not render the dialog when the explorer URL marker is absent", () => {
    vi.spyOn(attachmentsApiModule.attachmentsApi, "search").mockResolvedValue({ items: [], nextCursor: null })
    renderExplorer("/w/ws_1")
    expect(screen.queryByTestId("attachment-explorer")).not.toBeInTheDocument()
  })

  it("renders the dialog and issues a workspace-scoped search when the URL marker is present", async () => {
    const searchSpy = vi
      .spyOn(attachmentsApiModule.attachmentsApi, "search")
      .mockResolvedValue({ items: [makeItem()], nextCursor: null })

    renderExplorer("/w/ws_1?explorer=")

    await waitFor(() => expect(screen.getByTestId("attachment-explorer")).toBeInTheDocument())
    await waitFor(() => expect(searchSpy).toHaveBeenCalled())

    expect(searchSpy.mock.calls[0]).toMatchObject(["ws_1", { limit: 30 }])
    expect(searchSpy.mock.calls[0][1]).not.toHaveProperty("streamIds")

    expect(await screen.findByText("logo.png")).toBeInTheDocument()
  })

  it("should land the page on its list when the viewport narrows to a phone with a file selected", async () => {
    vi.spyOn(attachmentsApiModule.attachmentsApi, "search").mockResolvedValue({ items: [makeItem()], nextCursor: null })
    const isMobile = vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)

    const view = renderExplorer(
      "/w/ws_1/files?selected=attach_a",
      <ExplorerShell workspaceId="ws_1" mode="page" enabled />
    )
    expect(await screen.findByRole("button", { name: "Back to file list" })).toBeInTheDocument()

    isMobile.mockReturnValue(true)
    view.rerender()

    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to file list" })).not.toBeInTheDocument())
  })

  it("forwards a stream scope from the URL into the search request", async () => {
    const searchSpy = vi
      .spyOn(attachmentsApiModule.attachmentsApi, "search")
      .mockResolvedValue({ items: [], nextCursor: null })

    renderExplorer("/w/ws_1?explorer=&streams=str_design")

    await waitFor(() => expect(searchSpy).toHaveBeenCalled())
    expect(searchSpy.mock.calls[0]![1]).toMatchObject({ streamIds: ["str_design"], limit: 30 })
  })

  it("treats a quoted free-text query as exact substring", async () => {
    const searchSpy = vi
      .spyOn(attachmentsApiModule.attachmentsApi, "search")
      .mockResolvedValue({ items: [], nextCursor: null })

    renderExplorer(`/w/ws_1?explorer=&q=${encodeURIComponent('"q2 roadmap"')}`)

    await waitFor(() => expect(searchSpy).toHaveBeenCalled())
    expect(searchSpy.mock.calls[0]![1]).toMatchObject({ queryText: "q2 roadmap", exact: true })
  })

  it("reflects typed search text in the input synchronously, independent of URL state", async () => {
    // Regression: when the input was driven directly by `useSearchParams`,
    // mobile autocorrect's two-step word replacement saw a stale value
    // mid-replacement and concatenated the suggestion ("gurl" -> "Guelirl")
    // instead of substituting it. The input must update synchronously per
    // keystroke; URL sync is debounced.
    const searchSpy = vi
      .spyOn(attachmentsApiModule.attachmentsApi, "search")
      .mockResolvedValue({ items: [], nextCursor: null })

    renderExplorer("/w/ws_1?explorer=")

    const input = (await screen.findByLabelText("Search attachments")) as HTMLInputElement
    const user = userEvent.setup()
    await user.type(input, "girl")

    expect(input.value).toBe("girl")

    // And the URL eventually catches up so the search request fires.
    await waitFor(() => {
      const calls = searchSpy.mock.calls
      expect(calls[calls.length - 1]![1]).toMatchObject({ queryText: "girl" })
    })
  })

  it("autocorrect-style word replacement substitutes the word, not concatenates it", async () => {
    // Mobile autocorrect (iOS Safari, Android Chrome) replaces the misspelled
    // word in a single input event with `inputType: "insertReplacementText"`,
    // emitted as one onChange that swaps the whole value. Seed the input
    // with "gurl", then fire one change to "girl" — the same shape the
    // browser produces — and assert the local-state contract: the input
    // shows exactly the corrected word, not the concatenated "Guelirl".
    vi.spyOn(attachmentsApiModule.attachmentsApi, "search").mockResolvedValue({ items: [], nextCursor: null })

    renderExplorer("/w/ws_1?explorer=")

    const input = (await screen.findByLabelText("Search attachments")) as HTMLInputElement

    const user = userEvent.setup()
    await user.type(input, "gurl")
    expect(input.value).toBe("gurl")

    fireEvent.change(input, { target: { value: "girl" } })
    expect(input.value).toBe("girl")
  })

  it("renders the filtered-empty state when filters are active and results are empty", async () => {
    vi.spyOn(attachmentsApiModule.attachmentsApi, "search").mockResolvedValue({ items: [], nextCursor: null })

    renderExplorer("/w/ws_1?explorer=&type=pdf")

    expect(await screen.findByText("Nothing in this scope")).toBeInTheDocument()
  })
})
