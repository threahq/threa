import { act, type ReactNode } from "react"
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { fireEvent, render, screen, spyOnExport } from "@/test"
import { StreamTypes, Visibilities } from "@threa/types"
import { StreamItem } from "./stream-item"
import type { StreamItemData } from "./types"
import type { SidebarBoardMode } from "./board-sidebar-mode"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as touchCapableModule from "@/hooks/use-touch-capable"
import * as relativeTimeModule from "@/components/relative-time"
import * as drawerModule from "@/components/ui/drawer"
import * as streamSettingsModule from "@/components/stream-settings/use-stream-settings"
import * as urgencyTrackingModule from "./use-urgency-tracking"

const collapseOnMobile = vi.fn()
const openStreamSettings = vi.fn()
const setMenuOpen = vi.fn()

// Active input (useInputMode) and touch capability (useTouchCapable) are
// independent — a touch-capable laptop is mouse-driven — so drive them from
// separate fixture fields to cover the mixed-mode case.
const touchState = {
  inputMode: "touch" as "mouse" | "touch",
  touchCapable: true,
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
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
    touchState.inputMode = "touch"
    touchState.touchCapable = true

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

    // Active-input presentation (context-menu suppression, select-none) keys off
    // useInputMode; the long-press gesture keys off useTouchCapable. Drive both
    // from the same fixture flag so a touch fixture gets both behaviors.
    vi.spyOn(inputModeModule, "useInputMode").mockImplementation(() => touchState.inputMode)
    vi.spyOn(touchCapableModule, "useTouchCapable").mockImplementation(() => touchState.touchCapable)

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

  it("shows an unsent-draft hint on a stream with a loaded draft", () => {
    const stream = createStream({ hasLoadedDraft: true })

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

    expect(screen.getByRole("img", { name: "Unsent draft" })).toBeInTheDocument()
  })

  it("hides the unsent-draft hint on the active stream (its composer already shows the draft)", () => {
    const stream = createStream({ hasLoadedDraft: true })

    renderWithRouter(
      <StreamItem
        workspaceId="workspace_1"
        stream={stream}
        isActive
        unreadCount={0}
        mentionCount={0}
        allStreams={[stream]}
      />
    )

    expect(screen.queryByRole("img", { name: "Unsent draft" })).not.toBeInTheDocument()
  })

  it("shows no unsent-draft hint when the stream has no loaded draft", () => {
    const stream = createStream()

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

    expect(screen.queryByRole("img", { name: "Unsent draft" })).not.toBeInTheDocument()
  })

  it("renders a desktop context-menu trigger for DMs", () => {
    touchState.inputMode = "mouse"
    touchState.touchCapable = false

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

function makeBoardMode(over: Partial<SidebarBoardMode> = {}): SidebarBoardMode {
  return {
    workspaceId: "workspace_1",
    includedStreamIds: new Set<string>(),
    excludedStreamIds: new Set<string>(),
    mutedStreamIds: new Set<string>(),
    focusHref: (id) => `/w/workspace_1/board?in=${id}`,
    applyInclude: vi.fn(),
    applyExclude: vi.fn(),
    setMuted: vi.fn(),
    ...over,
  }
}

function renderBoardRow(stream: StreamItemData, boardMode: SidebarBoardMode) {
  return renderWithRouter(
    <StreamItem
      workspaceId="workspace_1"
      stream={stream}
      isActive={false}
      unreadCount={0}
      mentionCount={0}
      allStreams={[stream]}
      boardMode={boardMode}
    />
  )
}

describe("StreamItem — board mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    touchState.inputMode = "touch"
    touchState.touchCapable = true
    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      collapseOnMobile,
      setMenuOpen,
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)
    vi.spyOn(hooksModule, "isDraftId").mockImplementation(() => false)
    vi.spyOn(hooksModule, "useActors").mockReturnValue({
      getActorName: () => "Ariadne",
      getActorAvatar: () => null,
    } as unknown as ReturnType<typeof hooksModule.useActors>)
    vi.spyOn(inputModeModule, "useInputMode").mockImplementation(() => touchState.inputMode)
    vi.spyOn(touchCapableModule, "useTouchCapable").mockImplementation(() => touchState.touchCapable)
    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation(
      (() => null) as unknown as typeof relativeTimeModule.RelativeTime
    )
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
      <div>{children}</div>
    )) as unknown as typeof drawerModule.DrawerDescription)
    spyOnExport(drawerModule, "DrawerTitle").mockReturnValue((({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    )) as unknown as typeof drawerModule.DrawerTitle)
    vi.spyOn(streamSettingsModule, "useStreamSettings").mockReturnValue({
      openStreamSettings,
    } as unknown as ReturnType<typeof streamSettingsModule.useStreamSettings>)
    vi.spyOn(urgencyTrackingModule, "useUrgencyTracking").mockImplementation(() => undefined)
  })

  afterEach(() => vi.useRealTimers())

  it("points the row's Link at the focus href (a real navigation, back-friendly)", () => {
    const stream = createStream()
    renderBoardRow(stream, makeBoardMode())
    expect(screen.getByRole("link", { name: /general/i })).toHaveAttribute(
      "href",
      "/w/workspace_1/board?in=stream_general"
    )
  })

  it("cmd/ctrl-click applies an additive include instead of navigating", () => {
    const stream = createStream()
    const applyInclude = vi.fn()
    renderBoardRow(stream, makeBoardMode({ applyInclude }))
    const link = screen.getByRole("link", { name: /general/i })
    fireEvent.click(link, { metaKey: true })
    expect(applyInclude).toHaveBeenCalledWith("stream_general")
  })

  it("shows a checked tile toggle and tints the row when the stream is included", () => {
    const stream = createStream()
    renderBoardRow(stream, makeBoardMode({ includedStreamIds: new Set(["stream_general"]) }))
    const toggle = screen.getByRole("button", { name: /Remove .* from board filter/ })
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("link", { name: /general/i })).toHaveClass("bg-primary/10")
  })

  it("dims an excluded row and offers 'Include again' in the drawer", async () => {
    const stream = createStream()
    const applyExclude = vi.fn()
    renderBoardRow(stream, makeBoardMode({ excludedStreamIds: new Set(["stream_general"]), applyExclude }))
    expect(screen.getByRole("link", { name: /general/i })).toHaveClass("opacity-50")

    fireEvent.touchStart(screen.getByRole("link", { name: /general/i }), { touches: [{ clientX: 16, clientY: 16 }] })
    await act(async () => vi.advanceTimersByTime(500))
    fireEvent.click(screen.getByRole("button", { name: "Include again" }))
    expect(applyExclude).toHaveBeenCalledWith("stream_general")
  })

  it("renders a muted row dimmed with a bell-off glyph and the muted status line", () => {
    const stream = createStream()
    renderBoardRow(stream, makeBoardMode({ mutedStreamIds: new Set(["stream_general"]) }))
    expect(screen.getByLabelText("Muted on the board")).toBeInTheDocument()
    expect(screen.getByText("Muted on the board")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /general/i })).toHaveClass("opacity-50")
  })

  it("renders an E2E row as 'Not on the board' with no filter toggle", () => {
    const stream = createStream({ e2eEnabled: true })
    renderBoardRow(stream, makeBoardMode())
    expect(screen.getByText("Not on the board")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /board filter/ })).not.toBeInTheDocument()
  })

  it("points an E2E row's Link at the timeline, not an empty board scope", () => {
    const stream = createStream({ e2eEnabled: true })
    renderBoardRow(stream, makeBoardMode())
    expect(screen.getByRole("link", { name: /general/i })).toHaveAttribute("href", "/w/workspace_1/s/stream_general")
  })

  it("adds the board verbs to the action drawer, keeping the existing actions", async () => {
    const stream = createStream()
    renderBoardRow(stream, makeBoardMode())
    fireEvent.touchStart(screen.getByRole("link", { name: /general/i }), { touches: [{ clientX: 16, clientY: 16 }] })
    await act(async () => vi.advanceTimersByTime(500))
    for (const label of ["Add to filter", "Exclude from board", "Mute on board", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument()
    }
    // "Open timeline" is an href action — a Link (INV-40), not a button.
    expect(screen.getByRole("link", { name: "Open timeline" })).toBeInTheDocument()
  })

  it("keeps the board verbs out of the drawer in chats mode", async () => {
    const stream = createStream()
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
    fireEvent.touchStart(screen.getByRole("link", { name: /general/i }), { touches: [{ clientX: 16, clientY: 16 }] })
    await act(async () => vi.advanceTimersByTime(500))
    expect(screen.queryByRole("button", { name: "Add to filter" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument()
  })
})
