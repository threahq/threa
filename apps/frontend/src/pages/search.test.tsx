import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SidebarProvider } from "@/contexts/sidebar-context"
import { SearchPanelProvider } from "@/components/search/search-panel-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { mockSearchResultsList } from "@/test/fixtures/messages"
import { mockStreamsList } from "@/test/fixtures"
import { mockUsersList } from "@/test/fixtures/users"
import * as hooksModule from "@/hooks"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as contextsModule from "@/contexts"
import { SearchPage } from "./search"

const search = vi.fn()
const clear = vi.fn()

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/w/workspace_1/search?q=hello"]}>
          <SidebarProvider>
            <SearchPanelProvider workspaceId="workspace_1">
              <Routes>
                <Route path="/w/:workspaceId/search" element={<SearchPage />} />
              </Routes>
              <LocationProbe />
            </SearchPanelProvider>
          </SidebarProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("SearchPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    search.mockReset()
    clear.mockReset()
    vi.spyOn(hooksModule, "useSearch").mockReturnValue({
      results: [mockSearchResultsList[1]!, mockSearchResultsList[0]!],
      isLoading: false,
      error: null,
      search,
      clear,
    } as unknown as ReturnType<typeof hooksModule.useSearch>)
    vi.spyOn(mentionablesModule, "useMentionables").mockReturnValue({
      mentionables: [],
      isLoading: false,
    } as unknown as ReturnType<typeof mentionablesModule.useMentionables>)
    vi.spyOn(mentionablesModule, "filterMentionables").mockImplementation((items) => items)
    vi.spyOn(mentionablesModule, "filterSearchMentionables").mockImplementation((items) => items)
    vi.spyOn(mentionablesModule, "filterUsersOnly").mockImplementation((items) => items)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
      mockStreamsList as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
      mockUsersList as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([])
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: null,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(contextsModule, "useStreamService").mockReturnValue({ get: vi.fn() } as never)
  })

  it("shares ranked mode, API order, Link navigation, and touch-sized controls with the sidebar", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText("#general")).toBeInTheDocument()
    const ranked = screen.getByRole("radio", { name: "Ranked results" })
    expect(ranked).toHaveClass("h-9")
    await user.click(ranked)

    expect(
      Array.from(document.querySelectorAll("[data-search-result-id]"), (row) =>
        row.getAttribute("data-search-result-id")
      )
    ).toEqual(["msg_2", "msg_1"])
    expect(localStorage.getItem("threa-search-result-display:workspace_1")).toBe("ranked")

    await user.click(screen.getByText(/from the search results/))
    expect(screen.getByTestId("location")).toHaveTextContent("/w/workspace_1/s/stream_channel1?m=msg_1")
  })

  it("uses the persisted workspace-specific display mode", async () => {
    localStorage.setItem("threa-search-result-display:workspace_1", "ranked")
    localStorage.setItem("threa-search-result-display:workspace_2", "grouped")
    renderPage()

    await waitFor(() => expect(document.querySelector("section")).toBeNull())
    expect(screen.getByRole("radio", { name: "Ranked results" })).toHaveAttribute("data-state", "on")
  })

  it("keeps the as-you-type debounce free of a deep search", async () => {
    renderPage()

    await waitFor(() => {
      expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object))
    })
    expect(search.mock.calls.filter((call) => call[3]?.deep)).toEqual([])
  })

  it("runs a deep search on Enter without waiting for the debounce", async () => {
    const user = userEvent.setup()
    renderPage()

    const input = screen.getByLabelText("Search messages")
    await user.click(input)
    await user.keyboard("{Enter}")

    expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object), undefined, { deep: true })
  })

  it("runs a deep search from the Search deeper button", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole("button", { name: /search deeper/i }))

    expect(search).toHaveBeenLastCalledWith("hello", expect.any(Object), undefined, { deep: true })
  })
})
