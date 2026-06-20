import { Archive, Settings } from "lucide-react"
import { useRef, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { toast } from "sonner"
import { fireEvent, render, screen, userEvent, waitFor, spyOnExport } from "@/test"
import {
  SidebarActionContextMenu,
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
} from "./sidebar-actions"
import * as contextsModule from "@/contexts"
import * as relativeTimeModule from "@/components/relative-time"
import * as drawerModule from "@/components/ui/drawer"

const setMenuOpen = vi.fn()

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

function ContextMenuHarness({ actions }: { actions: SidebarActionItem[] }) {
  const ref = useRef<HTMLAnchorElement>(null)
  return (
    <SidebarActionContextMenu actions={actions} focusRef={ref}>
      <a ref={ref} href="/row" data-testid="row">
        Row
      </a>
    </SidebarActionContextMenu>
  )
}

describe("sidebar-actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setMenuOpen.mockReset()

    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      setMenuOpen,
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)

    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation((({
      date,
      className,
    }: {
      date: string
      className?: string
    }) => <span className={className}>{date}</span>) as unknown as typeof relativeTimeModule.RelativeTime)

    spyOnExport(drawerModule, "Drawer").mockReturnValue((({
      open,
      children,
    }: {
      open: boolean
      children: ReactNode
    }) => (
      <div data-testid="drawer-root" data-state={open ? "open" : "closed"}>
        {open ? children : null}
      </div>
    )) as unknown as typeof drawerModule.Drawer)
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

    vi.spyOn(toast, "error").mockImplementation(() => "" as unknown as ReturnType<typeof toast.error>)
  })

  describe("SidebarActionMenu", () => {
    it("renders the desktop trigger and menu actions", async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const actions: SidebarActionItem[] = [
        {
          id: "settings",
          label: "Settings",
          icon: Settings,
          onSelect,
        },
      ]

      renderWithRouter(<SidebarActionMenu actions={actions} ariaLabel="Stream actions" />)

      await user.click(screen.getByRole("button", { name: "Stream actions" }))
      await user.click(screen.getByText("Settings"))

      expect(onSelect).toHaveBeenCalled()
    })
  })

  describe("SidebarActionContextMenu", () => {
    it("opens on right-click and runs the selected action", async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const actions: SidebarActionItem[] = [{ id: "settings", label: "Settings", icon: Settings, onSelect }]

      renderWithRouter(
        <SidebarActionContextMenu actions={actions}>
          <div>Stream row</div>
        </SidebarActionContextMenu>
      )

      fireEvent.contextMenu(screen.getByText("Stream row"))

      await user.click(await screen.findByText("Settings"))

      expect(onSelect).toHaveBeenCalled()
      expect(setMenuOpen).toHaveBeenCalledWith(true)
    })

    it("renders children untouched when disabled", () => {
      const actions: SidebarActionItem[] = [{ id: "settings", label: "Settings", icon: Settings, onSelect: vi.fn() }]

      renderWithRouter(
        <SidebarActionContextMenu actions={actions} disabled>
          <div>Stream row</div>
        </SidebarActionContextMenu>
      )

      fireEvent.contextMenu(screen.getByText("Stream row"))

      expect(screen.queryByText("Settings")).not.toBeInTheDocument()
    })

    it("restores focus to the row element when the menu closes", async () => {
      const user = userEvent.setup()
      const actions: SidebarActionItem[] = [{ id: "settings", label: "Settings", icon: Settings, onSelect: vi.fn() }]

      renderWithRouter(<ContextMenuHarness actions={actions} />)

      fireEvent.contextMenu(screen.getByTestId("row"))
      await screen.findByText("Settings")

      await user.keyboard("{Escape}")

      await waitFor(() => expect(screen.getByTestId("row")).toHaveFocus())
    })

    it("renders children untouched when there are no actions", () => {
      renderWithRouter(
        <SidebarActionContextMenu actions={[]}>
          <div>Stream row</div>
        </SidebarActionContextMenu>
      )

      fireEvent.contextMenu(screen.getByText("Stream row"))

      expect(screen.getByText("Stream row")).toBeInTheDocument()
      expect(setMenuOpen).not.toHaveBeenCalled()
    })
  })

  describe("SidebarActionDrawer", () => {
    it("renders the stream preview and closes before invoking the selected action", async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      const onArchive = vi.fn()

      renderWithRouter(
        <SidebarActionDrawer
          streamName="General"
          title="Actions for General"
          description="Choose an action for this stream."
          open={true}
          onOpenChange={onOpenChange}
          actions={[
            {
              id: "archive",
              label: "Archive",
              icon: Archive,
              onSelect: onArchive,
              variant: "destructive",
            },
          ]}
          preview={{
            authorName: "Ariadne",
            content: "Latest update from the stream",
            createdAt: "2026-03-03T10:00:00Z",
          }}
        />
      )

      expect(screen.getByText("General")).toBeInTheDocument()
      expect(screen.getByText("Ariadne")).toBeInTheDocument()
      expect(screen.getByText("Latest update from the stream")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Archive" }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onArchive).toHaveBeenCalled()
    })

    it("renders a custom header when provided", () => {
      renderWithRouter(
        <SidebarActionDrawer
          open={true}
          onOpenChange={vi.fn()}
          actions={[]}
          title="Account menu"
          description="Choose an account action."
          header={<div>Signed in as Kris</div>}
        />
      )

      expect(screen.getByText("Signed in as Kris")).toBeInTheDocument()
    })

    it("keeps preview-only drawers mounted while closing", () => {
      renderWithRouter(
        <SidebarActionDrawer
          open={false}
          onOpenChange={vi.fn()}
          actions={[]}
          streamName="Taylor"
          title="Actions for Taylor"
          description="Choose an action for this stream."
          preview={{
            content: "No messages yet",
          }}
        />
      )

      expect(screen.getByTestId("drawer-root")).toHaveAttribute("data-state", "closed")
    })

    it("renders link actions as anchors", () => {
      renderWithRouter(
        <SidebarActionDrawer
          open={true}
          onOpenChange={vi.fn()}
          actions={[
            {
              id: "ai-usage",
              label: "AI Usage",
              icon: Archive,
              href: "/w/workspace_1/admin/ai-usage",
            },
          ]}
          title="Account menu"
          description="Choose an account action."
        />
      )

      expect(screen.getByRole("link", { name: "AI Usage" })).toHaveAttribute("href", "/w/workspace_1/admin/ai-usage")
    })

    it("surfaces async action failures", async () => {
      const user = userEvent.setup()
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const error = new Error("Archive failed")

      renderWithRouter(
        <SidebarActionDrawer
          open={true}
          onOpenChange={vi.fn()}
          actions={[
            {
              id: "archive",
              label: "Archive",
              icon: Archive,
              onSelect: vi.fn().mockRejectedValue(error),
            },
          ]}
        />
      )

      await user.click(screen.getByRole("button", { name: "Archive" }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Archive failed")
        expect(consoleErrorSpy).toHaveBeenCalledWith('Sidebar action "archive" failed:', error)
      })

      consoleErrorSpy.mockRestore()
    })
  })
})
