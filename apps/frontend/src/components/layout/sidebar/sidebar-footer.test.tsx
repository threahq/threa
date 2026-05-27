import type { ReactNode } from "react"
import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, userEvent, spyOnExport } from "@/test"
import { SidebarFooter } from "./sidebar-footer"
import * as authModule from "@/auth"
import * as contextsModule from "@/contexts"
import * as useMobileModule from "@/hooks/use-mobile"
import * as drawerModule from "@/components/ui/drawer"

const logout = vi.fn()
const openSettings = vi.fn()
const collapseOnMobile = vi.fn()
const isMobile = { value: true }

function renderWithRouter(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe("SidebarFooter", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    logout.mockReset()
    openSettings.mockReset()
    collapseOnMobile.mockReset()
    isMobile.value = true

    vi.spyOn(authModule, "useAuth").mockReturnValue({
      logout,
    } as unknown as ReturnType<typeof authModule.useAuth>)

    vi.spyOn(contextsModule, "useSettings").mockReturnValue({
      openSettings,
    } as unknown as ReturnType<typeof contextsModule.useSettings>)

    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      collapseOnMobile,
      setMenuOpen: vi.fn(),
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)

    vi.spyOn(useMobileModule, "useIsMobile").mockImplementation(() => isMobile.value)

    spyOnExport(drawerModule, "Drawer").mockReturnValue((({
      open,
      children,
    }: {
      open: boolean
      children: ReactNode
    }) => (open ? <div>{children}</div> : null)) as unknown as typeof drawerModule.Drawer)
    spyOnExport(drawerModule, "DrawerContent").mockReturnValue((({
      children,
      className,
    }: {
      children: ReactNode
      className?: string
    }) => <div className={className}>{children}</div>) as unknown as typeof drawerModule.DrawerContent)
    spyOnExport(drawerModule, "DrawerDescription").mockReturnValue((({
      children,
      className,
    }: {
      children: ReactNode
      className?: string
    }) => <div className={className}>{children}</div>) as unknown as typeof drawerModule.DrawerDescription)
    spyOnExport(drawerModule, "DrawerTitle").mockReturnValue((({
      children,
      className,
    }: {
      children: ReactNode
      className?: string
    }) => <div className={className}>{children}</div>) as unknown as typeof drawerModule.DrawerTitle)
  })

  it("opens the mobile account drawer on tap and exposes the same actions", async () => {
    const user = userEvent.setup()

    renderWithRouter(
      <SidebarFooter
        workspaceId="workspace_1"
        currentUser={{
          id: "user_1",
          workspaceId: "workspace_1",
          workosUserId: "workos_user_1",
          email: "kris@example.com",
          role: "member",
          slug: "kris",
          name: "Kris",
          description: null,
          avatarUrl: null,
          timezone: "Europe/Stockholm",
          locale: "en-SE",
          pronouns: null,
          phone: null,
          githubUsername: null,
          setupCompleted: true,
          joinedAt: "2026-03-03T10:00:00Z",
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: /kris/i }))

    expect(screen.getByText("kris@example.com")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "AI Usage" })).toHaveAttribute("href", "/w/workspace_1/admin/ai-usage")

    await user.click(screen.getByRole("button", { name: "Settings" }))

    expect(openSettings).toHaveBeenCalledWith("appearance")
    expect(collapseOnMobile).toHaveBeenCalled()
  })

  it("opens the desktop dropdown from the account row trigger", async () => {
    isMobile.value = false
    const user = userEvent.setup()

    renderWithRouter(
      <SidebarFooter
        workspaceId="workspace_1"
        currentUser={{
          id: "user_1",
          workspaceId: "workspace_1",
          workosUserId: "workos_user_1",
          email: "kris@example.com",
          role: "member",
          slug: "kris",
          name: "Kris",
          description: null,
          avatarUrl: null,
          timezone: "Europe/Stockholm",
          locale: "en-SE",
          pronouns: null,
          phone: null,
          githubUsername: null,
          setupCompleted: true,
          joinedAt: "2026-03-03T10:00:00Z",
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: /kris/i }))
    await user.click(screen.getByText("Settings"))

    expect(openSettings).toHaveBeenCalledWith("appearance")
  })
})
