import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorkspaceBootstrap } from "@threa/types"
import { render, screen, userEvent, waitFor } from "@/test"
import * as authModule from "@/auth"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { clearCallState, setCallPhase } from "@/stores/call-store"

type SeedData = Parameters<typeof seedWorkspaceCache>[1]
type CachedWorkspaceUser = SeedData["users"][number]
type CachedDmPeer = SeedData["dmPeers"][number]
import type { CallController } from "@/calls/call-manager"
import { CallLaunchProvider } from "@/components/call/call-launch-context"
import { CallManagerProvider } from "@/components/call/call-manager-context"
import { UserProfileModal } from "./user-profile-modal"

const WORKSPACE_ID = "workspace_1"
const PEER_ID = "usr_peer"

function cachedUser(overrides: Partial<CachedWorkspaceUser>): CachedWorkspaceUser {
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

function seed(dmPeers: CachedDmPeer[]) {
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
      cachedUser({ id: "usr_self", workosUserId: "workos_self", slug: "self", name: "Ada" }),
      cachedUser({ id: PEER_ID, workosUserId: "workos_peer", slug: "grace", name: "Grace" }),
    ],
    streams: [],
    memberships: [],
    dmPeers,
    personas: [],
    bots: [],
  })
}

function makeManager(): CallController {
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
  }
}

function renderModal(manager: CallController, callsEnabled: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // `calls` is a workspace-scope flag defaulting on; an off workspace override
  // turns the affordance dark. Seed the bootstrap's raw flag layers the hook reads.
  queryClient.setQueryData(workspaceKeys.bootstrap(WORKSPACE_ID), {
    featureFlags: { workspace: callsEnabled ? {} : { calls: "off" }, user: {} },
  } as unknown as WorkspaceBootstrap)
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}`]}>
        <CallManagerProvider manager={manager}>
          <CallLaunchProvider>
            <Routes>
              <Route
                path="/w/:workspaceId"
                element={<UserProfileModal userId={PEER_ID} open onOpenChange={() => {}} />}
              />
            </Routes>
          </CallLaunchProvider>
        </CallManagerProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const withDm: CachedDmPeer[] = [
  {
    id: `${WORKSPACE_ID}:stream_dm`,
    workspaceId: WORKSPACE_ID,
    userId: PEER_ID,
    streamId: "stream_dm",
    _cachedAt: Date.now(),
  },
]

beforeEach(() => {
  resetWorkspaceStoreCache()
  clearCallState()
  vi.spyOn(authModule, "useAuth").mockReturnValue({ user: { id: "workos_self" } } as ReturnType<
    typeof authModule.useAuth
  >)
})

afterEach(() => vi.restoreAllMocks())

describe("UserProfileModal — Call entry point", () => {
  it("hides Call entirely when the workspace calls flag is off", () => {
    seed(withDm)
    renderModal(makeManager(), false)
    expect(screen.getByRole("link", { name: /Message/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Call$/i })).toBeNull()
  })

  it("disables Call until a DM exists (v1 has no message-less DM materialization)", () => {
    seed([])
    renderModal(makeManager(), true)
    expect(screen.getByRole("button", { name: /^Call$/i })).toBeDisabled()
  })

  it("starts a call on the existing DM stream when enabled", async () => {
    seed(withDm)
    const manager = makeManager()
    renderModal(manager, true)
    await userEvent.click(screen.getByRole("button", { name: /^Call$/i }))
    await waitFor(() =>
      expect(manager.startCall).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        streamId: "stream_dm",
        mode: "video",
      })
    )
  })

  it("disables Call while the viewer is already in a call", () => {
    seed(withDm)
    setCallPhase("connected")
    renderModal(makeManager(), true)
    expect(screen.getByRole("button", { name: /^Call$/i })).toBeDisabled()
  })

  it("exposes the disabled reason through a focusable tooltip trigger, not a bare title", () => {
    seed([])
    renderModal(makeManager(), true)
    const callBtn = screen.getByRole("button", { name: /^Call$/i })
    expect(callBtn).toBeDisabled()
    // A disabled button isn't focusable and screen readers ignore an ancestor's
    // `title`, so the reason lives on a focusable Radix tooltip trigger instead.
    const wrapper = callBtn.parentElement as HTMLElement
    expect(wrapper).toHaveAttribute("tabindex", "0")
    expect(wrapper).toHaveAttribute("data-state")
    expect(wrapper).not.toHaveAttribute("title")
  })
})
