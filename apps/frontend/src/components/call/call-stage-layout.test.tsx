import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { useState } from "react"
import { render, screen, userEvent, within } from "@/test"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { clearCallState, type CallRosterParticipant } from "@/stores/call-store"
import type { CallFilmstripSide, CallLayout } from "@/stores/call-prefs-store"
import type { CallController } from "@/calls/call-manager"
import { CallStageLayout } from "./call-stage-layout"
import { CallManagerProvider } from "./call-manager-context"

type CachedWorkspaceUser = Parameters<typeof seedWorkspaceCache>[1]["users"][number]

const WORKSPACE_ID = "workspace_1"

function user(overrides: Partial<CachedWorkspaceUser>): CachedWorkspaceUser {
  return {
    id: "usr_x",
    workspaceId: WORKSPACE_ID,
    workosUserId: "workos_x",
    email: "x@example.com",
    role: "member",
    slug: "x",
    name: "X",
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
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
    joinedAt: "2026-03-01T10:00:00Z",
    _cachedAt: Date.now(),
    ...overrides,
  } as CachedWorkspaceUser
}

function participant(overrides: Partial<CallRosterParticipant>): CallRosterParticipant {
  return {
    userId: "usr_self",
    participantStatus: "joined",
    endpointId: "callep_self",
    connectionStatus: "connected",
    mediaState: {},
    publishedTracks: [],
    ...overrides,
  }
}

function makeManager(overrides: Partial<CallController> = {}): CallController {
  return {
    startCall: vi.fn(async () => {}),
    leaveCall: vi.fn(async () => {}),
    setMuted: vi.fn(),
    setCameraOn: vi.fn(async () => {}),
    switchInputDevice: vi.fn(async () => {}),
    switchCameraDevice: vi.fn(async () => {}),
    flipCamera: vi.fn(async () => {}),
    setOutputDevice: vi.fn(async () => {}),
    getVideoStream: vi.fn(() => null),
    ...overrides,
  }
}

function seedUsers() {
  seedWorkspaceCache(WORKSPACE_ID, {
    workspace: {
      id: WORKSPACE_ID,
      name: "Workspace",
      slug: "workspace",
      createdAt: "2026-03-01T10:00:00Z",
      updatedAt: "2026-03-01T10:00:00Z",
      _cachedAt: Date.now(),
    },
    users: [
      user({ id: "usr_self", workosUserId: "workos_self", slug: "self", name: "Ada" }),
      user({ id: "usr_a", workosUserId: "workos_a", slug: "a", name: "Grace" }),
      user({ id: "usr_b", workosUserId: "workos_b", slug: "b", name: "Linus" }),
    ],
    streams: [],
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

/** A controlled host holding the view-only pin, mirroring the mobile drawer's FullscreenView. */
function Host({
  layout,
  filmstripSide = "bottom",
  participants,
}: {
  layout: CallLayout
  filmstripSide?: CallFilmstripSide
  participants: CallRosterParticipant[]
}) {
  const [pinnedUserId, setPinnedUserId] = useState<string | null>(null)
  return (
    <CallManagerProvider manager={makeManager()}>
      <CallStageLayout
        layout={layout}
        filmstripSide={filmstripSide}
        participants={participants}
        currentUserId="usr_self"
        workspaceId={WORKSPACE_ID}
        pinnedUserId={pinnedUserId}
        onPin={setPinnedUserId}
      />
    </CallManagerProvider>
  )
}

const THREE = [
  participant({ userId: "usr_self", endpointId: "callep_self" }),
  participant({ userId: "usr_a", endpointId: "callep_a" }),
  participant({ userId: "usr_b", endpointId: "callep_b" }),
]

/** The large speaker tile is the direct-child CallTile of the stage-main region (the PiP's is nested). */
function bigTileUserId(): string | null {
  const main = screen.getByTestId("call-stage-main")
  return main.querySelector(":scope > [data-testid='call-tile']")?.getAttribute("data-user-id") ?? null
}

beforeEach(() => {
  clearCallState()
  resetWorkspaceStoreCache()
  seedUsers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("CallStageLayout — grid", () => {
  it("renders one equal tile per participant", () => {
    render(<Host layout="grid" participants={THREE} />)
    expect(screen.getByTestId("call-stage-grid")).toBeInTheDocument()
    expect(screen.getAllByTestId("call-tile")).toHaveLength(3)
    // No self-PiP in grid; the self tile is just another tile.
    expect(screen.queryByTestId("call-self-pip")).toBeNull()
  })

  it("ignores non-joined participants", () => {
    render(
      <Host
        layout="grid"
        participants={[
          participant({ userId: "usr_self" }),
          participant({ userId: "usr_a", endpointId: "callep_a", participantStatus: "left" }),
        ]}
      />
    )
    expect(screen.getAllByTestId("call-tile")).toHaveLength(1)
  })
})

describe("CallStageLayout — speaker", () => {
  it("renders one large tile, a filmstrip of the rest, and the self PiP", () => {
    render(<Host layout="speaker" participants={THREE} />)
    // Default speaker = first joined non-self peer (usr_a).
    expect(bigTileUserId()).toBe("usr_a")
    expect(screen.getByTestId("call-self-pip")).toBeInTheDocument()
    // Filmstrip holds the remaining peer (usr_b) — not the speaker, not self.
    const strip = screen.getByTestId("call-filmstrip")
    const stripUsers = within(strip)
      .getAllByTestId("call-tile")
      .map((t) => t.getAttribute("data-user-id"))
    expect(stripUsers).toEqual(["usr_b"])
  })

  it("solo self: self is the large tile, no filmstrip, no PiP", () => {
    render(<Host layout="speaker" participants={[participant({ userId: "usr_self" })]} />)
    expect(bigTileUserId()).toBe("usr_self")
    expect(screen.queryByTestId("call-filmstrip")).toBeNull()
    expect(screen.queryByTestId("call-self-pip")).toBeNull()
  })

  it("filmstripSide places the strip: bottom = row, side = column", () => {
    const { rerender } = render(<Host layout="speaker" filmstripSide="bottom" participants={THREE} />)
    const bottom = screen.getByTestId("call-stage-speaker")
    expect(bottom).toHaveAttribute("data-filmstrip-side", "bottom")
    expect(bottom.className).toContain("flex-col")
    expect(screen.getByTestId("call-filmstrip").className).toContain("overflow-x-auto")

    rerender(<Host layout="speaker" filmstripSide="side" participants={THREE} />)
    const side = screen.getByTestId("call-stage-speaker")
    expect(side).toHaveAttribute("data-filmstrip-side", "side")
    expect(side.className).toContain("flex-row")
    expect(screen.getByTestId("call-filmstrip").className).toContain("overflow-y-auto")
  })

  it("tapping a filmstrip tile pins that user as the large speaker", async () => {
    render(<Host layout="speaker" participants={THREE} />)
    expect(bigTileUserId()).toBe("usr_a")

    // usr_b is in the filmstrip; pin them.
    await userEvent.click(screen.getByRole("button", { name: "Pin Linus" }))

    expect(bigTileUserId()).toBe("usr_b")
    // usr_a now takes the filmstrip slot.
    const stripUsers = within(screen.getByTestId("call-filmstrip"))
      .getAllByTestId("call-tile")
      .map((t) => t.getAttribute("data-user-id"))
    expect(stripUsers).toEqual(["usr_a"])
  })
})
