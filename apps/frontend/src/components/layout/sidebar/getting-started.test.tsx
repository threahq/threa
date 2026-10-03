import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter, useLocation } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import { render, screen, userEvent, waitFor } from "@/test"
import { onboardingApi } from "@/api"
import { workspaceKeys } from "@/hooks/use-workspaces"
import {
  GettingStarted,
  hasWrittenFirstNote,
  useGettingStarted,
  type UseGettingStartedOptions,
} from "./getting-started"
import * as contextsModule from "@/contexts"
import * as pushModule from "@/hooks/use-push-notifications"
import { StreamTypes, type User, type WorkspaceBootstrap } from "@threahq/types"

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

/** Surfaces the current location so invite-task and navigation clicks can be asserted. */
function LocationProbe() {
  const location = useLocation()
  return (
    <>
      <div data-testid="location-search">{location.search}</div>
      <div data-testid="location-path">{location.pathname}</div>
    </>
  )
}

/**
 * Mounts the hook the way Sidebar does and renders the card from its state,
 * plus a probe for the account-menu restore path (canRestore + restore()).
 */
function Harness(props: UseGettingStartedOptions) {
  const state = useGettingStarted(props)
  return (
    <>
      <GettingStarted state={state} />
      <div data-testid="can-restore">{String(state.canRestore)}</div>
      <button type="button" onClick={state.restore}>
        restore-probe
      </button>
    </>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function renderCard(props: Partial<UseGettingStartedOptions> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Harness
          workspaceId="workspace_1"
          currentUser={baseUser}
          hasWrittenNote={false}
          onboardingStreamId={null}
          memberCount={1}
          onCreateScratchpad={vi.fn()}
          {...props}
        />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("GettingStarted", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    queryClient.clear()
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

    expect(screen.getByText("Getting started · 0/5")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Turn on notifications" }))
    expect(requestPermission).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Add a profile photo" }))
    expect(openSettings).toHaveBeenCalledWith("profile")

    await user.click(screen.getByRole("button", { name: "Write your first note" }))
    expect(onCreateScratchpad).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Invite your team" }))
    expect(screen.getByTestId("location-search")).toHaveTextContent("ws-settings=users")
  })

  it("should show Meet Ariadne after the first-note task and mark it done when onboardingStreamId is set", () => {
    const { unmount } = renderCard()
    const labels = screen.getAllByRole("listitem").map((item) => item.textContent)
    expect(labels.indexOf("Meet Ariadne")).toBe(labels.indexOf("Write your first note") + 1)
    unmount()

    renderCard({ onboardingStreamId: "stream_onboarding" })
    expect(screen.queryByRole("button", { name: "Meet Ariadne" })).not.toBeInTheDocument()
    expect(screen.getByText("Meet Ariadne")).toHaveClass("line-through")
  })

  it("should create the Ariadne scratchpad, cache its id, and open it when Meet Ariadne is selected", async () => {
    const user = userEvent.setup()
    const meetAriadne = vi.spyOn(onboardingApi, "meetAriadne").mockResolvedValue({ streamId: "stream_onboarding" })
    queryClient.setQueryData(workspaceKeys.bootstrap("workspace_1"), { users: [] } as unknown as WorkspaceBootstrap)
    renderCard()

    await user.click(screen.getByRole("button", { name: "Meet Ariadne" }))

    await waitFor(() =>
      expect(screen.getByTestId("location-path")).toHaveTextContent("/w/workspace_1/s/stream_onboarding")
    )
    expect(meetAriadne).toHaveBeenCalledWith("workspace_1")
    expect(collapseOnMobile).toHaveBeenCalled()
    expect(queryClient.getQueryData(workspaceKeys.bootstrap("workspace_1"))).toEqual({
      users: [],
      onboardingStreamId: "stream_onboarding",
    })
  })

  it("should toast an error and stay put when Meet Ariadne fails", async () => {
    const user = userEvent.setup()
    vi.spyOn(onboardingApi, "meetAriadne").mockRejectedValue(new Error("boom"))
    const toastError = vi.spyOn(toast, "error").mockReturnValue("t")
    renderCard()

    await user.click(screen.getByRole("button", { name: "Meet Ariadne" }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't start the conversation with Ariadne"))
    expect(screen.getByTestId("location-path")).toHaveTextContent("/")
    expect(collapseOnMobile).not.toHaveBeenCalled()
  })

  it("marks derived-complete tasks done and stops offering them as actions", () => {
    mockPush({ isSubscribed: true, permission: "granted" })
    renderCard({
      currentUser: { ...baseUser, avatarUrl: "https://cdn/avatar.png" },
      hasWrittenNote: true,
      onboardingStreamId: "stream_onboarding",
    })

    expect(screen.getByText("Getting started · 4/5")).toBeInTheDocument()
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
      onboardingStreamId: "stream_onboarding",
      memberCount: 3,
    })

    expect(screen.queryByText(/Getting started/)).not.toBeInTheDocument()
  })

  it("hides the invite task for plain members", () => {
    renderCard({ currentUser: { ...baseUser, role: "member" } })

    expect(screen.getByText("Getting started · 0/4")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Invite your team" })).not.toBeInTheDocument()
  })

  it("hides the notifications task when push is unsupported or disabled on the server", () => {
    mockPush({ permission: "unsupported" })
    renderCard()

    expect(screen.getByText("Getting started · 0/4")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).not.toBeInTheDocument()
  })

  it("persists dismissal through user preferences", async () => {
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getByRole("button", { name: "Dismiss getting started" }))
    expect(updatePreference).toHaveBeenCalledWith("gettingStartedDismissed", true)
  })

  it("renders nothing when previously dismissed but offers the restore path", async () => {
    const user = userEvent.setup()
    mockPreferences(true)
    renderCard()

    expect(screen.queryByText(/Getting started ·/)).not.toBeInTheDocument()
    expect(screen.getByTestId("can-restore")).toHaveTextContent("true")

    await user.click(screen.getByRole("button", { name: "restore-probe" }))
    expect(updatePreference).toHaveBeenCalledWith("gettingStartedDismissed", false)
  })

  it("offers no restore path once every task derives as done", () => {
    mockPreferences(true)
    mockPush({ isSubscribed: true, permission: "granted" })
    renderCard({
      currentUser: { ...baseUser, avatarUrl: "https://cdn/avatar.png" },
      hasWrittenNote: true,
      onboardingStreamId: "stream_onboarding",
      memberCount: 3,
    })

    expect(screen.getByTestId("can-restore")).toHaveTextContent("false")
  })
})

describe("hasWrittenFirstNote", () => {
  const scratchpad = { id: "stream_pad", type: StreamTypes.SCRATCHPAD }
  const onboarding = { id: "stream_onboarding", type: StreamTypes.SCRATCHPAD }

  it("should count a user scratchpad and ignore the Meet Ariadne one", () => {
    expect(hasWrittenFirstNote([scratchpad], "stream_onboarding")).toBe(true)
    expect(hasWrittenFirstNote([onboarding], "stream_onboarding")).toBe(false)
    expect(hasWrittenFirstNote([onboarding, scratchpad], "stream_onboarding")).toBe(true)
    expect(hasWrittenFirstNote([onboarding], null)).toBe(true)
  })

  it("should count the system scratchpad only once it has a message", () => {
    expect(hasWrittenFirstNote([{ id: "s", type: StreamTypes.SYSTEM, lastMessagePreview: null }], null)).toBe(false)
    expect(hasWrittenFirstNote([{ id: "s", type: StreamTypes.SYSTEM, lastMessagePreview: { id: "m" } }], null)).toBe(
      true
    )
  })
})
