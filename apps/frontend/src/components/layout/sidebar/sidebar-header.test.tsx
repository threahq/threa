import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { SidebarHeader } from "./sidebar-header"
import * as contextsModule from "@/contexts"
import * as searchPanelModule from "@/components/search/search-panel-context"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { resetJournalCacheForTests, writeJournal } from "@/lib/navigation-journal"

const openSwitcher = vi.fn()
const openSearch = vi.fn()
const collapseOnMobile = vi.fn()
const isTouch = { value: false }

function renderHeader() {
  return render(
    <MemoryRouter>
      <SidebarHeader workspaceName="Threa" workspaceId="ws_1" />
    </MemoryRouter>
  )
}

describe("SidebarHeader", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    openSwitcher.mockReset()
    openSearch.mockReset()
    collapseOnMobile.mockReset()
    isTouch.value = false

    vi.spyOn(contextsModule, "useQuickSwitcher").mockReturnValue({
      openSwitcher,
    } as unknown as ReturnType<typeof contextsModule.useQuickSwitcher>)
    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      collapseOnMobile,
      setMenuOpen: vi.fn(),
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { keyboardShortcuts: {} },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(searchPanelModule, "useSearchPanel").mockReturnValue({
      openSearch,
    } as unknown as ReturnType<typeof searchPanelModule.useSearchPanel>)
    vi.spyOn(inputModeModule, "useInputMode").mockImplementation(() => (isTouch.value ? "touch" : "mouse"))
    vi.spyOn(authModule, "useAuth").mockReturnValue({ user: { id: "usr_1" } } as unknown as ReturnType<
      typeof authModule.useAuth
    >)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([])
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([])
    localStorage.clear()
    resetJournalCacheForTests()
  })

  it("opens the search panel from the header's icon button", async () => {
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole("button", { name: /Search messages/i }))

    expect(openSearch).toHaveBeenCalled()
  })

  it("offers both quick-switch modes from the command menu on mouse input", async () => {
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole("button", { name: "Jump to stream or command" }))
    expect(screen.getByRole("menuitem", { name: /Jump to stream/i })).toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: /Commands/i }))

    expect(openSwitcher).toHaveBeenCalledWith("command")
  })

  it("opens the same dropdown menu, not a drawer, on touch input", async () => {
    isTouch.value = true
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole("button", { name: "Jump to stream or command" }))
    await user.click(screen.getByRole("menuitem", { name: /Jump to stream/i }))

    expect(openSwitcher).toHaveBeenCalledWith("stream")
  })

  it("disables both history steps when the journal is empty", async () => {
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole("button", { name: "History" }))

    expect(screen.queryByRole("link", { name: /Back/ })).toBeNull()
    expect(screen.getByRole("menuitem", { name: /Back/ })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("menuitem", { name: /Forward/ })).toHaveAttribute("aria-disabled", "true")
  })

  it("lists the earlier streams newest first and links Back to the previous entry", async () => {
    writeJournal("usr_1", "ws_1", {
      entries: [
        { path: "/w/ws_1/s/stream_a", at: 1 },
        { path: "/w/ws_1/s/stream_b", at: 2 },
        { path: "/w/ws_1/s/stream_c", at: 3 },
      ],
      cursor: 2,
    })
    // stream_a is no longer cached (deleted, or not hydrated yet): it has no
    // name to show and no page to open, so it gets no row.
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
      { id: "stream_b", type: "channel", slug: "bravo" },
      { id: "stream_c", type: "channel", slug: "charlie" },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>)
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole("button", { name: "History" }))

    expect(screen.getAllByRole("menuitem").map((item) => item.getAttribute("href"))).toEqual([
      "/w/ws_1/s/stream_b",
      null,
      "/w/ws_1/s/stream_b",
    ])
    expect(screen.getByRole("menuitem", { name: /#bravo/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Back/ })).toHaveAttribute("href", "/w/ws_1/s/stream_b")
    expect(screen.getByRole("menuitem", { name: /Forward/ })).toHaveAttribute("aria-disabled", "true")
  })
})
