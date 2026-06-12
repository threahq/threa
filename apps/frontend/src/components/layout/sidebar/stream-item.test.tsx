import { act, type ReactNode } from "react"
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { fireEvent, render, screen, spyOnExport } from "@/test"
import { StreamTypes, Visibilities } from "@threa/types"
import { StreamItem } from "./stream-item"
import type { StreamItemData } from "./types"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as useMobileModule from "@/hooks/use-mobile"
import * as relativeTimeModule from "@/components/relative-time"
import * as drawerModule from "@/components/ui/drawer"
import * as streamSettingsModule from "@/components/stream-settings/use-stream-settings"
import * as urgencyTrackingModule from "./use-urgency-tracking"

const collapseOnMobile = vi.fn()
const openStreamSettings = vi.fn()
const setMenuOpen = vi.fn()

const mobileState = {
  isMobileValue: true,
}

function renderWithRouter(ui: React.ReactElement) {
  // PanelProvider backs the cmd-click "open in panel" affordance on the link.
  return render(
    <MemoryRouter>
      <contextsModule.PanelProvider>{ui}</contextsModule.PanelProvider>
    </MemoryRouter>
  )
}

function createStream(overrides: Partial<StreamItemData> = {}): StreamItemData {
  return {
    id: "stream_general",
    workspaceId: "workspace_1",
    type: StreamTypes.CHANNEL,
    displayName: "General",
    slug: "general",
    description: null,
    visibility: Visibilities.PUBLIC,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-03-03T09:00:00Z",
    updatedAt: "2026-03-03T09:00:00Z",
    archivedAt: null,
    urgency: "activity",
    section: "recent",
    lastMessagePreview: {
      authorId: "user_1",
      authorType: "persona",
      content: "Latest update from the stream",
      createdAt: "2026-03-03T10:00:00Z",
    },
    ...overrides,
  }
}

describe("StreamItem", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    collapseOnMobile.mockReset()
    openStreamSettings.mockReset()
    setMenuOpen.mockReset()
    mobileState.isMobileValue = true

    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      collapseOnMobile,
      setMenuOpen,
      setUrgencyBlock: vi.fn(),
      sidebarHeight: 0,
      scrollContainerOffset: 0,
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)

    vi.spyOn(hooksModule, "isDraftId").mockImplementation(() => false)
    vi.spyOn(hooksModule, "useActors").mockReturnValue({
      getActorName: () => "Ariadne",
      getActorAvatar: () => null,
    } as unknown as ReturnType<typeof hooksModule.useActors>)

    vi.spyOn(useMobileModule, "useIsMobile").mockImplementation(() => mobileState.isMobileValue)

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

    vi.spyOn(streamSettingsModule, "useStreamSettings").mockReturnValue({
      openStreamSettings,
    } as unknown as ReturnType<typeof streamSettingsModule.useStreamSettings>)

    vi.spyOn(urgencyTrackingModule, "useUrgencyTracking").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens the mobile action drawer with the latest preview on long press", async () => {
    const stream = createStream()

    renderWithRouter(
      <StreamItem
        workspaceId="workspace_1"
        stream={stream}
        isActive={false}
        unreadCount={1}
        mentionCount={0}
        allStreams={[stream]}
      />
    )

    const link = screen.getByRole("link", { name: /general/i })

    fireEvent.touchStart(link, {
      touches: [{ clientX: 16, clientY: 16 }],
    })

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByText("Ariadne")).toBeInTheDocument()
    expect(screen.getByText("Latest update from the stream")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))

    expect(openStreamSettings).toHaveBeenCalledWith("stream_general")
  })

  it("keeps compact hover previews hidden on mobile", () => {
    const stream = createStream()

    const { container } = renderWithRouter(
      <StreamItem
        workspaceId="workspace_1"
        stream={stream}
        isActive={false}
        unreadCount={1}
        mentionCount={0}
        allStreams={[stream]}
        compact
        showPreviewOnHover
      />
    )

    const preview = container.querySelector(".text-xs.text-muted-foreground")
    expect(preview).toHaveClass("hidden")
    expect(preview).not.toHaveClass("group-hover:flex")
  })

  it("opens the action drawer for DMs on mobile", async () => {
    const stream = createStream({
      id: "stream_dm_1",
      type: StreamTypes.DM,
      displayName: "Taylor",
      slug: null,
      dmPeerUserId: "user_2",
    })

    renderWithRouter(
      <StreamItem
        workspaceId="workspace_1"
        stream={stream}
        isActive={false}
        unreadCount={1}
        mentionCount={0}
        allStreams={[stream]}
      />
    )

    const link = screen.getByRole("link", { name: /taylor/i })

    fireEvent.touchStart(link, {
      touches: [{ clientX: 16, clientY: 16 }],
    })

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getAllByText("Taylor")).toHaveLength(2)
    expect(screen.getByText("Latest update from the stream")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(openStreamSettings).toHaveBeenCalledWith("stream_dm_1")
  })

  it("shows a no-messages fallback preview for DMs without a last message", async () => {
    const stream = createStream({
      id: "stream_dm_2",
      type: StreamTypes.DM,
      displayName: "Jordan",
      slug: null,
      dmPeerUserId: "user_3",
      lastMessagePreview: null,
    })

    renderWithRouter(
      <StreamItem
        workspaceId="workspace_1"
        stream={stream}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
        allStreams={[stream]}
      />
    )

    const link = screen.getByRole("link", { name: /jordan/i })

    fireEvent.touchStart(link, {
      touches: [{ clientX: 16, clientY: 16 }],
    })

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByText("No messages yet")).toBeInTheDocument()
    expect(screen.queryByText("Ariadne")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument()
  })

  it("renders a desktop context-menu trigger for DMs", () => {
    mobileState.isMobileValue = false

    const stream = createStream({
      id: "stream_dm_1",
      type: StreamTypes.DM,
      displayName: "Taylor",
      slug: null,
      dmPeerUserId: "user_2",
    })

    renderWithRouter(
      <StreamItem
        workspaceId="workspace_1"
        stream={stream}
        isActive={false}
        unreadCount={1}
        mentionCount={0}
        allStreams={[stream]}
      />
    )

    expect(screen.getByRole("button", { name: "Stream actions" })).toBeInTheDocument()
  })
})
