import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ShareMessageModal } from "./share-message-modal"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as shareHandoffStoreModule from "@/stores/share-handoff-store"
import * as useMobileModule from "@/hooks/use-mobile"

const SAMPLE_ATTRS = {
  messageId: "msg_a",
  streamId: "stream_source",
  authorName: "Ada",
  authorId: "usr_a",
  actorType: "user",
}

function mountModal({ initialPath = "/w/ws_1/s/current" }: { initialPath?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/w/:workspaceId/s/:streamId"
          element={<ShareMessageModal open onOpenChange={() => {}} workspaceId="ws_1" attrs={SAMPLE_ATTRS} />}
        />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  // Default to desktop unless a test overrides — keeps the picker-rendering
  // tests pinned to one surface so cmdk-item assertions are stable.
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  // No unread state in these picker tests; the modal reads counts/mute from
  // here for urgency-based sorting and would otherwise hit Dexie on mount.
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue(
    undefined as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUnreadState>
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ShareMessageModal — picker filtering", () => {
  it("shows accessible top-level streams grouped by type and hides threads/archives/inaccessible private", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
      {
        id: "ch_pub",
        type: "channel",
        visibility: "public",
        displayName: "#general",
        slug: "general",
        archivedAt: null,
        rootStreamId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "ch_priv_member",
        type: "channel",
        visibility: "private",
        displayName: "#team",
        slug: "team",
        archivedAt: null,
        rootStreamId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "ch_priv_outsider",
        type: "channel",
        visibility: "private",
        displayName: "#secret",
        slug: "secret",
        archivedAt: null,
        rootStreamId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "ch_archived",
        type: "channel",
        visibility: "public",
        displayName: "#old",
        slug: "old",
        archivedAt: "2026-01-01",
        rootStreamId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "thread_a",
        type: "thread",
        visibility: "public",
        displayName: "branch",
        slug: null,
        archivedAt: null,
        rootStreamId: "ch_pub",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "dm_self",
        type: "dm",
        visibility: "private",
        displayName: null,
        slug: null,
        archivedAt: null,
        rootStreamId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "scratch_self",
        type: "scratchpad",
        visibility: "private",
        displayName: "Notes",
        slug: null,
        archivedAt: null,
        rootStreamId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue([
      {
        id: "ws_1:ch_priv_member",
        workspaceId: "ws_1",
        streamId: "ch_priv_member",
        memberId: "usr_self",
      },
      { id: "ws_1:dm_self", workspaceId: "ws_1", streamId: "dm_self", memberId: "usr_self" },
      { id: "ws_1:scratch_self", workspaceId: "ws_1", streamId: "scratch_self", memberId: "usr_self" },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamMemberships>)

    mountModal()

    // Items render inside aria-hidden Radix subtrees (portal + scroll-lock),
    // so the ARIA-aware queries miss them. `data-value` is set per item by
    // cmdk and reflects our `value={stream.id}` — query by attribute and
    // assert on textContent instead.
    const items = document.querySelectorAll<HTMLElement>("[cmdk-item][data-value]")
    const visibleStreamIds = Array.from(items).map((el) => el.getAttribute("data-value"))
    expect(visibleStreamIds).toContain("ch_pub")
    expect(visibleStreamIds).toContain("ch_priv_member")
    expect(visibleStreamIds).toContain("dm_self")
    expect(visibleStreamIds).toContain("scratch_self")
    expect(visibleStreamIds).not.toContain("ch_priv_outsider")
    expect(visibleStreamIds).not.toContain("ch_archived")
    expect(visibleStreamIds).not.toContain("thread_a")
    // Channel labels surface the slug-prefixed name; scratchpad uses displayName.
    expect(items[0].textContent).toContain("#general")
    const scratchItem = Array.from(items).find((el) => el.getAttribute("data-value") === "scratch_self")
    expect(scratchItem?.textContent).toContain("Notes")
  })

  it("queues the share-handoff and navigates on select", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
      {
        id: "ch_target",
        type: "channel",
        visibility: "public",
        displayName: "#general",
        slug: "general",
        archivedAt: null,
        rootStreamId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamMemberships>
    )
    const queue = vi.spyOn(shareHandoffStoreModule, "queueShareHandoff").mockImplementation(() => {})

    mountModal()
    const item = document.querySelector<HTMLElement>('[cmdk-item][data-value="ch_target"]')
    expect(item).not.toBeNull()
    fireEvent.click(item!)

    expect(queue).toHaveBeenCalledWith("ch_target", SAMPLE_ATTRS)
  })
})

describe("ShareMessageModal — E2E source confirms before decrypt-to-public", () => {
  const TARGET = [
    {
      id: "ch_target",
      type: "channel",
      visibility: "public",
      displayName: "#general",
      slug: "general",
      archivedAt: null,
      rootStreamId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>

  it("requires confirmation, then queues the decrypted plaintext (not a pointer)", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(TARGET)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamMemberships>
    )
    const queuePointer = vi.spyOn(shareHandoffStoreModule, "queueShareHandoff").mockImplementation(() => {})
    const queuePlaintext = vi.spyOn(shareHandoffStoreModule, "queuePlaintextShareHandoff").mockImplementation(() => {})

    render(
      <MemoryRouter initialEntries={["/w/ws_1/s/current"]}>
        <Routes>
          <Route
            path="/w/:workspaceId/s/:streamId"
            element={
              <ShareMessageModal
                open
                onOpenChange={() => {}}
                workspaceId="ws_1"
                attrs={SAMPLE_ATTRS}
                sourcePlaintext="the launch codename is VELVET-OTTER"
              />
            }
          />
        </Routes>
      </MemoryRouter>
    )

    // Picking a target does NOT immediately queue — a confirmation appears first.
    fireEvent.click(document.querySelector<HTMLElement>('[cmdk-item][data-value="ch_target"]')!)
    expect(queuePlaintext).not.toHaveBeenCalled()
    expect(queuePointer).not.toHaveBeenCalled()

    // Confirm → the decrypted plaintext is queued as a public share, never a pointer.
    const confirm = [...document.querySelectorAll("button")].find((b) => /Share & decrypt/i.test(b.textContent ?? ""))
    expect(confirm).toBeTruthy()
    fireEvent.click(confirm!)

    expect(queuePlaintext).toHaveBeenCalledWith("ch_target", "the launch codename is VELVET-OTTER", SAMPLE_ATTRS)
    expect(queuePointer).not.toHaveBeenCalled()
  })
})

describe("ShareMessageModal — surface selection", () => {
  it("renders as a centered Dialog on desktop", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamMemberships>
    )
    mountModal()
    // Radix Dialog wraps content in a portal with role=dialog.
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    // Vaul's drawer adds a vaul-* attribute set; assert no drawer root present.
    expect(document.querySelector("[vaul-drawer-wrapper]")).toBeNull()
  })

  it("renders as a bottom-sheet Drawer on mobile", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamMemberships>
    )
    mountModal()
    // Vaul exposes data-vaul-drawer attributes on its content surface.
    const drawerContent = document.querySelector("[data-vaul-drawer]")
    expect(drawerContent).not.toBeNull()
  })
})
