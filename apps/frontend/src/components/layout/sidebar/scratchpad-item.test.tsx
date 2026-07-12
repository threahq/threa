import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom"
import { fireEvent, render, screen, waitFor } from "@/test"
import { StreamTypes, Visibilities } from "@threa/types"
import { ScratchpadItem } from "./scratchpad-item"
import type { StreamItemData } from "./types"
import type { SidebarBoardMode } from "./board-sidebar-mode"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as streamSettingsModule from "@/components/stream-settings/use-stream-settings"
import * as urgencyTrackingModule from "./use-urgency-tracking"
import * as itemDrawerModule from "./use-sidebar-item-drawer"
import * as sidebarActionsModule from "./sidebar-actions"

const collapseOnMobile = vi.fn()
const archiveStream = vi.fn(async () => {})
const deleteScratchpad = vi.fn(async () => {})
const openStreamSettings = vi.fn()

function LocationEcho() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderWithRouter(ui: React.ReactElement, initialPath = "/w/workspace_1/stream/stream_scratchpad_1") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {ui}
              <LocationEcho />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

function createScratchpad(overrides: Partial<StreamItemData> = {}): StreamItemData {
  return {
    id: "stream_scratchpad_1",
    workspaceId: "workspace_1",
    type: StreamTypes.SCRATCHPAD,
    displayName: "Notes",
    slug: null,
    description: null,
    visibility: Visibilities.PRIVATE,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "on",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-03-03T09:00:00Z",
    updatedAt: "2026-03-03T09:00:00Z",
    archivedAt: null,
    urgency: "activity",
    section: "recent",
    lastMessagePreview: null,
    ...overrides,
  }
}

describe("ScratchpadItem", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    collapseOnMobile.mockReset()
    archiveStream.mockReset()
    deleteScratchpad.mockReset()
    openStreamSettings.mockReset()

    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      collapseOnMobile,
      setMenuOpen: vi.fn(),
      setUrgencyBlock: vi.fn(),
      sidebarHeight: 0,
      scrollContainerOffset: 0,
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)

    vi.spyOn(hooksModule, "isDraftId").mockImplementation((id: string) => id.startsWith("draft_"))
    vi.spyOn(hooksModule, "useActors").mockReturnValue({
      getActorName: () => "Ariadne",
      getActorAvatar: () => null,
    } as unknown as ReturnType<typeof hooksModule.useActors>)
    vi.spyOn(hooksModule, "useArchiveStream").mockReturnValue({
      mutateAsync: archiveStream,
    } as unknown as ReturnType<typeof hooksModule.useArchiveStream>)
    vi.spyOn(hooksModule, "useDraftScratchpads").mockReturnValue({
      deleteScratchpad,
    } as unknown as ReturnType<typeof hooksModule.useDraftScratchpads>)
    vi.spyOn(hooksModule, "useStreamOrDraft").mockImplementation(() => {
      throw new Error("ScratchpadItem should not call useStreamOrDraft")
    })

    vi.spyOn(streamSettingsModule, "useStreamSettings").mockReturnValue({
      openStreamSettings,
    } as unknown as ReturnType<typeof streamSettingsModule.useStreamSettings>)

    vi.spyOn(urgencyTrackingModule, "useUrgencyTracking").mockImplementation(() => undefined)

    vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("mouse")

    vi.spyOn(itemDrawerModule, "useSidebarItemDrawer").mockImplementation(
      ({ collapseOnMobile }: { collapseOnMobile: () => void }) =>
        ({
          drawerOpen: false,
          setDrawerOpen: vi.fn(),
          handleClick: () => collapseOnMobile(),
          touchCapable: false,
          longPress: {
            handlers: {
              onTouchStart: undefined,
              onTouchEnd: undefined,
              onTouchMove: undefined,
              onContextMenu: undefined,
            },
            isPressed: false,
          },
        }) as unknown as ReturnType<typeof itemDrawerModule.useSidebarItemDrawer>
    )

    vi.spyOn(sidebarActionsModule, "SidebarActionMenu").mockImplementation((({
      actions,
      ariaLabel,
    }: {
      actions: Array<{ id: string; label: string; onSelect: () => void }>
      ariaLabel: string
    }) => (
      <div aria-label={ariaLabel}>
        {actions.map((action) => (
          <button key={action.id} type="button" onClick={action.onSelect}>
            {action.label}
          </button>
        ))}
      </div>
    )) as unknown as typeof sidebarActionsModule.SidebarActionMenu)
    vi.spyOn(sidebarActionsModule, "SidebarActionDrawer").mockImplementation(() => null)
  })

  it("archives real scratchpads without mounting the page-level stream hook", async () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad()}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
      />
    )

    expect(screen.getByText("Settings")).toBeInTheDocument()

    const initialPath = screen.getByTestId("location").textContent

    fireEvent.click(screen.getByText("Archive"))

    await waitFor(() => {
      expect(archiveStream).toHaveBeenCalledWith("stream_scratchpad_1")
    })
    // URL should not have changed since no navigation happens on archive
    expect(screen.getByTestId("location").textContent).toBe(initialPath)
  })

  it("offers the Labels… action on real scratchpads", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad()}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
      />
    )

    expect(screen.getByText("Labels…")).toBeInTheDocument()
  })

  it("shows the AI companion badge on companion-on scratchpads", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "on" })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
      />
    )

    expect(screen.getByLabelText("AI companion attached")).toBeInTheDocument()
  })

  it("hides the AI companion badge on companion-off scratchpads", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "off" })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
      />
    )

    expect(screen.queryByLabelText("AI companion attached")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Encrypted scratchpad")).not.toBeInTheDocument()
  })

  it("shows the lock badge on encrypted scratchpads instead of the companion badge", () => {
    // INV-E1 forces companion off for E2E streams server-side, so we only ever
    // see this combination in the wild.
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "off", e2eEnabled: true })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
      />
    )

    expect(screen.getByLabelText("Encrypted scratchpad")).toBeInTheDocument()
    expect(screen.queryByLabelText("AI companion attached")).not.toBeInTheDocument()
  })

  it("shows a loader instead of the placeholder while an encrypted scratchpad's sealed name decrypts", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ e2eEnabled: true, companionMode: "off", displayName: null, nameDecrypting: true })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
      />
    )

    // Neither the decrypted name nor the "New scratchpad" placeholder flashes
    // while the name is still resolving.
    expect(screen.queryByText("New scratchpad")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Encrypted scratchpad")).toBeInTheDocument()
  })

  it("renders the decrypted name once resolved (no loader)", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({
          e2eEnabled: true,
          companionMode: "off",
          displayName: "Therapy notes",
          nameDecrypting: false,
        })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
      />
    )

    expect(screen.getByText("Therapy notes")).toBeInTheDocument()
  })

  it("deletes draft scratchpads directly and navigates away when the active draft is removed", async () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ id: "draft_scratchpad_1", displayName: null })}
        isActive
        unreadCount={0}
        mentionCount={0}
      />,
      "/w/workspace_1/drafts/draft_scratchpad_1"
    )

    expect(screen.queryByText("Settings")).not.toBeInTheDocument()
    expect(screen.getByText("New scratchpad")).toBeInTheDocument()

    fireEvent.click(screen.getByText("Delete"))

    await waitFor(() => {
      expect(deleteScratchpad).toHaveBeenCalledWith("draft_scratchpad_1")
      expect(screen.getByTestId("location").textContent).toBe("/w/workspace_1")
    })
    expect(archiveStream).not.toHaveBeenCalled()
  })

  function boardMode(over: Partial<SidebarBoardMode> = {}): SidebarBoardMode {
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

  it("board mode: the row Link focuses the board on this scratchpad", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "off" })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
        boardMode={boardMode()}
      />
    )
    expect(screen.getByRole("link", { name: /notes/i })).toHaveAttribute(
      "href",
      "/w/workspace_1/board?in=stream_scratchpad_1"
    )
  })

  it("board mode: an included scratchpad shows a checked toggle and offers the filter verbs", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "off" })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
        boardMode={boardMode({ includedStreamIds: new Set(["stream_scratchpad_1"]) })}
      />
    )
    expect(screen.getByRole("button", { name: /Remove Notes from board filter/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    for (const label of ["Remove from filter", "Exclude from board", "Mute on board", "Open timeline", "Settings"]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it("board mode: a muted scratchpad dims with a bell-off glyph and the muted status line", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "off" })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
        boardMode={boardMode({ mutedStreamIds: new Set(["stream_scratchpad_1"]) })}
      />
    )
    expect(screen.getByLabelText("Muted on the board")).toBeInTheDocument()
    expect(screen.getByText("Muted on the board")).toBeInTheDocument()
    expect(screen.getByText("Unmute on board")).toBeInTheDocument()
  })

  it("board mode: an E2E scratchpad reads 'Not on the board', keeps its lock, and has no filter toggle", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "off", e2eEnabled: true })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
        boardMode={boardMode()}
      />
    )
    expect(screen.getByText("Not on the board")).toBeInTheDocument()
    expect(screen.getByLabelText("Encrypted scratchpad")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /board filter/ })).not.toBeInTheDocument()
    // Escape hatch stays; scope verbs don't apply to an off-board stream.
    expect(screen.getByText("Open timeline")).toBeInTheDocument()
    expect(screen.queryByText("Add to filter")).not.toBeInTheDocument()
  })

  it("board mode: an E2E scratchpad's row Link opens the timeline, not an empty board scope", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "off", e2eEnabled: true })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
        boardMode={boardMode()}
      />
    )
    expect(screen.getByRole("link", { name: /Notes/i })).toHaveAttribute("href", "/w/workspace_1/s/stream_scratchpad_1")
  })

  it("chats mode: no board verbs on the scratchpad", () => {
    renderWithRouter(
      <ScratchpadItem
        workspaceId="workspace_1"
        stream={createScratchpad({ companionMode: "off" })}
        isActive={false}
        unreadCount={0}
        mentionCount={0}
      />
    )
    expect(screen.queryByText("Add to filter")).not.toBeInTheDocument()
    expect(screen.queryByText("Open timeline")).not.toBeInTheDocument()
    expect(screen.getByText("Settings")).toBeInTheDocument()
  })
})
