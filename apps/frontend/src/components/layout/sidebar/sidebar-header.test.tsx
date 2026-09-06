import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { SidebarHeader } from "./sidebar-header"
import * as contextsModule from "@/contexts"
import * as searchPanelModule from "@/components/search/search-panel-context"
import * as inputModeModule from "@/hooks/use-input-mode"

const openSwitcher = vi.fn()
const openSearch = vi.fn()
const collapseOnMobile = vi.fn()
const isTouch = { value: false }

function renderHeader() {
  return render(
    <MemoryRouter>
      <SidebarHeader workspaceName="Threa" />
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
})
