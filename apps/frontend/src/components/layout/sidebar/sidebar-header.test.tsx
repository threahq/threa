import type { ReactNode } from "react"
import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen, userEvent, spyOnExport } from "@/test"
import { SidebarHeader } from "./sidebar-header"
import * as contextsModule from "@/contexts"
import * as searchPanelModule from "@/components/search/search-panel-context"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as drawerModule from "@/components/ui/drawer"

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

    spyOnExport(drawerModule, "Drawer").mockReturnValue((({
      open,
      children,
    }: {
      open: boolean
      children: ReactNode
    }) => (open ? <div>{children}</div> : null)) as unknown as typeof drawerModule.Drawer)
    spyOnExport(drawerModule, "DrawerContent").mockReturnValue((({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    )) as unknown as typeof drawerModule.DrawerContent)
    spyOnExport(drawerModule, "DrawerDescription").mockReturnValue((({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    )) as unknown as typeof drawerModule.DrawerDescription)
    spyOnExport(drawerModule, "DrawerTitle").mockReturnValue((({ children }: { children: ReactNode }) => (
      <h2>{children}</h2>
    )) as unknown as typeof drawerModule.DrawerTitle)
  })

  it("opens the search panel from the header's icon button", async () => {
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole("button", { name: /Search messages/i }))

    expect(openSearch).toHaveBeenCalled()
  })

  it("offers both quick-switch modes from the notch menu on mouse input", async () => {
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole("button", { name: "Jump to stream or command" }))
    expect(screen.getByRole("menuitem", { name: /Jump to stream/i })).toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: /Commands/i }))

    expect(openSwitcher).toHaveBeenCalledWith("command")
  })

  it("offers the same modes in a drawer on touch input", async () => {
    isTouch.value = true
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole("button", { name: "Jump to stream or command" }))
    await user.click(screen.getByText("Jump to stream"))

    expect(openSwitcher).toHaveBeenCalledWith("stream")
  })
})
