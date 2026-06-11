import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter, useLocation } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { GettingStarted } from "./getting-started"
import * as contextsModule from "@/contexts"
import * as pushModule from "@/hooks/use-push-notifications"
import type { User } from "@threa/types"

const openSettings = vi.fn()
const collapseOnMobile = vi.fn()
const updatePreference = vi.fn()
const requestPermission = vi.fn()

const baseUser: User = {
  id: "user_1",
  workspaceId: "workspace_1",
  workosUserId: "workos_user_1",
  email: "kris@example.com",
  role: "owner",
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
}

type PushResult = ReturnType<typeof pushModule.usePushNotifications>

function mockPush(overrides: Partial<PushResult> = {}) {
  vi.spyOn(pushModule, "usePushNotifications").mockReturnValue({
    permission: "default",
    isSubscribed: false,
    status: "idle",
    error: null,
    optedOut: false,
    pushDisabledOnServer: false,
    requestPermission,
    unsubscribe: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  } as PushResult)
}

function mockPreferences(gettingStartedDismissed: boolean) {
  vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
    preferences: { gettingStartedDismissed },
    updatePreference,
  } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
}

/** Surfaces the current search string so invite-task clicks can be asserted. */
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-search">{location.search}</div>
}

function renderCard(props: Partial<React.ComponentProps<typeof GettingStarted>> = {}) {
  return render(
    <MemoryRouter>
      <GettingStarted
        workspaceId="workspace_1"
        currentUser={baseUser}
        hasWrittenNote={false}
        memberCount={1}
        onCreateScratchpad={vi.fn()}
        {...props}
      />
      <LocationProbe />
    </MemoryRouter>
  )
}

describe("GettingStarted", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    openSettings.mockReset()
    collapseOnMobile.mockReset()
    updatePreference.mockReset()
    requestPermission.mockReset()

    vi.spyOn(contextsModule, "useSettings").mockReturnValue({
      openSettings,
    } as unknown as ReturnType<typeof contextsModule.useSettings>)
    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      collapseOnMobile,
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)
    mockPreferences(false)
    mockPush()
  })

  it("renders the open tasks with progress and routes each to its surface", async () => {
    const user = userEvent.setup()
    const onCreateScratchpad = vi.fn()
    renderCard({ onCreateScratchpad })

    expect(screen.getByText("Getting started · 0/4")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Turn on notifications" }))
    expect(requestPermission).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Add a profile photo" }))
    expect(openSettings).toHaveBeenCalledWith("profile")

    await user.click(screen.getByRole("button", { name: "Write your first note" }))
    expect(onCreateScratchpad).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Invite your team" }))
    expect(screen.getByTestId("location-search")).toHaveTextContent("ws-settings=users")
  })

  it("marks derived-complete tasks done and stops offering them as actions", () => {
    mockPush({ isSubscribed: true, permission: "granted" })
    renderCard({ currentUser: { ...baseUser, avatarUrl: "https://cdn/avatar.png" }, hasWrittenNote: true })

    expect(screen.getByText("Getting started · 3/4")).toBeInTheDocument()
    // The only remaining actionable task is the invite.
    expect(screen.getByRole("button", { name: "Invite your team" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add a profile photo" })).not.toBeInTheDocument()
  })

  it("disappears entirely once every task derives as done", () => {
    mockPush({ isSubscribed: true, permission: "granted" })
    renderCard({
      currentUser: { ...baseUser, avatarUrl: "https://cdn/avatar.png" },
      hasWrittenNote: true,
      memberCount: 3,
    })

    expect(screen.queryByText(/Getting started/)).not.toBeInTheDocument()
  })

  it("hides the invite task for plain members", () => {
    renderCard({ currentUser: { ...baseUser, role: "member" } })

    expect(screen.getByText("Getting started · 0/3")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Invite your team" })).not.toBeInTheDocument()
  })

  it("hides the notifications task when push is unsupported or disabled on the server", () => {
    mockPush({ permission: "unsupported" })
    renderCard()

    expect(screen.getByText("Getting started · 0/3")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).not.toBeInTheDocument()
  })

  it("persists dismissal through user preferences", async () => {
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getByRole("button", { name: "Dismiss getting started" }))
    expect(updatePreference).toHaveBeenCalledWith("gettingStartedDismissed", true)
  })

  it("renders nothing when previously dismissed", () => {
    mockPreferences(true)
    renderCard()

    expect(screen.queryByText(/Getting started/)).not.toBeInTheDocument()
  })
})
