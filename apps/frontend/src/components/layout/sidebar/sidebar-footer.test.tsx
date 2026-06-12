import type { ReactNode } from "react"
import { User as UserIcon } from "lucide-react"
import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, userEvent, spyOnExport } from "@/test"
import { SidebarFooter } from "./sidebar-footer"
import * as authModule from "@/auth"
import * as contextsModule from "@/contexts"
import * as useMobileModule from "@/hooks/use-mobile"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
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

    // The footer mounts useStatusAutoExpiry and useNotificationPauseAutoExpiry,
    // which resolve their mutations through the services context the unit
    // harness doesn't provide.
    vi.spyOn(useWorkspacesModule, "useClearStatus").mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useWorkspacesModule.useClearStatus>)
    vi.spyOn(useWorkspacesModule, "useResumeNotifications").mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useWorkspacesModule.useResumeNotifications>)

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
        onCreateScratchpad={vi.fn()}
        onCreateChannel={vi.fn()}
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
          statusEmoji: null,
          statusText: null,
          statusExpiresAt: null,
          statusPausesNotifications: false,
          notificationsPausedUntil: null,
          notificationsPausedIndefinitely: false,
          setupCompleted: true,
          joinedAt: "2026-03-03T10:00:00Z",
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: /kris/i }))

    // The identity card at the top of the menu is the status affordance (no
    // status set in this fixture, so it invites the user to set one).
    expect(screen.getByRole("button", { name: "Set a status" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "AI Usage" })).toHaveAttribute("href", "/w/workspace_1/admin/ai-usage")

    // A single Settings entry — Profile is the dialog's default tab, not a
    // second menu row into the same dialog.
    expect(screen.queryByRole("button", { name: "Profile" })).not.toBeInTheDocument()
    // No restore callback provided → no Getting started row.
    expect(screen.queryByText("Getting started")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Settings" }))

    expect(openSettings).toHaveBeenCalledWith("profile")
    expect(collapseOnMobile).toHaveBeenCalled()
  })

  it("offers a Getting started row that restores the dismissed checklist", async () => {
    const user = userEvent.setup()
    const onShowGettingStarted = vi.fn()

    renderWithRouter(
      <SidebarFooter
        workspaceId="workspace_1"
        onCreateScratchpad={vi.fn()}
        onCreateChannel={vi.fn()}
        onShowGettingStarted={onShowGettingStarted}
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
          statusEmoji: null,
          statusText: null,
          statusExpiresAt: null,
          statusPausesNotifications: false,
          notificationsPausedUntil: null,
          notificationsPausedIndefinitely: false,
          setupCompleted: true,
          joinedAt: "2026-03-03T10:00:00Z",
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: /kris/i }))
    await user.click(screen.getByText("Getting started"))

    expect(onShowGettingStarted).toHaveBeenCalled()
  })

  it("opens the create drawer from the New button and exposes every stream flavor", async () => {
    const user = userEvent.setup()
    const onCreateScratchpad = vi.fn()
    const onCreateChannel = vi.fn()

    renderWithRouter(
      <SidebarFooter
        workspaceId="workspace_1"
        onCreateScratchpad={onCreateScratchpad}
        onCreateChannel={onCreateChannel}
        scratchpadAddMenuActions={[
          { id: "new-scratchpad", label: "New Scratchpad", icon: UserIcon, onSelect: onCreateScratchpad },
          { id: "new-quick-note", label: "New Quick Note", icon: UserIcon, onSelect: vi.fn() },
        ]}
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
          statusEmoji: null,
          statusText: null,
          statusExpiresAt: null,
          statusPausesNotifications: false,
          notificationsPausedUntil: null,
          notificationsPausedIndefinitely: false,
          setupCompleted: true,
          joinedAt: "2026-03-03T10:00:00Z",
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: "New" }))

    // The provided scratchpad flavors plus the appended channel creator.
    expect(screen.getByText("New Scratchpad")).toBeInTheDocument()
    expect(screen.getByText("New Quick Note")).toBeInTheDocument()
    await user.click(screen.getByText("New Channel"))
    expect(onCreateChannel).toHaveBeenCalled()
  })

  it("opens the desktop dropdown from the account row trigger", async () => {
    isMobile.value = false
    const user = userEvent.setup()

    renderWithRouter(
      <SidebarFooter
        workspaceId="workspace_1"
        onCreateScratchpad={vi.fn()}
        onCreateChannel={vi.fn()}
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
          statusEmoji: null,
          statusText: null,
          statusExpiresAt: null,
          statusPausesNotifications: false,
          notificationsPausedUntil: null,
          notificationsPausedIndefinitely: false,
          setupCompleted: true,
          joinedAt: "2026-03-03T10:00:00Z",
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: /kris/i }))
    await user.click(screen.getByText("Settings"))

    expect(openSettings).toHaveBeenCalledWith("profile")
  })

  it("surfaces a do-not-disturb label in the account header when notifications are paused", async () => {
    const user = userEvent.setup()

    renderWithRouter(
      <SidebarFooter
        workspaceId="workspace_1"
        onCreateScratchpad={vi.fn()}
        onCreateChannel={vi.fn()}
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
          statusEmoji: null,
          statusText: null,
          statusExpiresAt: null,
          statusPausesNotifications: false,
          notificationsPausedUntil: null,
          notificationsPausedIndefinitely: true,
          setupCompleted: true,
          joinedAt: "2026-03-03T10:00:00Z",
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: /kris/i }))

    // The pause label appears both in the identity header and on the account
    // menu's resume entry's description line.
    expect(screen.getAllByText(/Notifications paused/i).length).toBeGreaterThan(0)
    // While paused, the menu offers a one-tap resume rather than a pause entry.
    expect(screen.getByText("Resume notifications")).toBeInTheDocument()
  })

  it("offers a pause-notifications entry in the account menu when not paused", async () => {
    const user = userEvent.setup()

    renderWithRouter(
      <SidebarFooter
        workspaceId="workspace_1"
        onCreateScratchpad={vi.fn()}
        onCreateChannel={vi.fn()}
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
          statusEmoji: null,
          statusText: null,
          statusExpiresAt: null,
          statusPausesNotifications: false,
          notificationsPausedUntil: null,
          notificationsPausedIndefinitely: false,
          setupCompleted: true,
          joinedAt: "2026-03-03T10:00:00Z",
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: /kris/i }))

    expect(screen.getByText("Pause notifications")).toBeInTheDocument()
    expect(screen.queryByText("Resume notifications")).not.toBeInTheDocument()
  })
})
