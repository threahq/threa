import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, WORKSPACE_PERMISSION_SCOPES, type GuestDmPolicy, type WorkspaceBootstrap } from "@threahq/types"
import { spyOnExport } from "@/test"
import { createMockStream } from "@/test/fixtures"
import { createMockUser } from "@/test/fixtures/users"
import { GUEST_DM_READ_ONLY_REASON } from "@/lib/guest-dm-policy"
import * as authModule from "@/auth"
import * as contextsModule from "@/contexts"
import { CoordinatedLoadingProvider, PanelProvider, ServicesProvider } from "@/contexts"
import { SyncStatusContext, SyncStatusStore } from "@/sync/sync-status"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { ReadCommitQueue, ReadCommitQueueContext } from "@/sync/read-commit-queue"
import * as messageInputModule from "./message-input"
import { StreamContent } from "./stream-content"

const WORKSPACE_ID = "ws_1"
const DM_STREAM = createMockStream({ id: "stream_dm", type: StreamTypes.DM, workspaceId: WORKSPACE_ID })
const viewer = createMockUser({ id: "usr_viewer", workosUserId: "workos_viewer", role: "member" })
const guest = createMockUser({ id: "usr_guest", workosUserId: "workos_guest", role: "guest" })

type StoreUsers = ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
type StoreDmPeers = ReturnType<typeof workspaceStoreModule.useWorkspaceDmPeers>

function renderDm(policy: GuestDmPolicy, stream = DM_STREAM) {
  const readCommitQueue = new ReadCommitQueue({ commitRef: { current: vi.fn() } })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspacesModule.workspaceKeys.bootstrap(WORKSPACE_ID), {
    viewerPermissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE],
    workspaceSettings: { guestDmPolicy: policy },
  } as WorkspaceBootstrap)
  return render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider>
        <ReadCommitQueueContext.Provider value={readCommitQueue}>
          <MemoryRouter>
            <SyncStatusContext.Provider value={new SyncStatusStore()}>
              <PanelProvider>
                <CoordinatedLoadingProvider workspaceId={WORKSPACE_ID} streamIds={[]}>
                  <StreamContent workspaceId={WORKSPACE_ID} streamId={stream.id} stream={stream} />
                </CoordinatedLoadingProvider>
              </PanelProvider>
            </SyncStatusContext.Provider>
          </MemoryRouter>
        </ReadCommitQueueContext.Provider>
      </ServicesProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { keyboardShortcuts: {} },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_viewer" } as ReturnType<typeof authModule.useUser>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([viewer, guest] as StoreUsers)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([
    { userId: guest.id, streamId: DM_STREAM.id },
  ] as StoreDmPeers)
  spyOnExport(messageInputModule, "MessageInput").mockReturnValue(((props: {
    disabled?: boolean
    disabledReason?: string
  }) => (
    <div data-testid="composer" data-disabled={String(!!props.disabled)}>
      {props.disabledReason}
    </div>
  )) as never)
})

afterEach(() => vi.restoreAllMocks())

function composerState() {
  const composer = screen.getByTestId("composer")
  return { disabled: composer.dataset.disabled, reason: composer.textContent }
}

describe("StreamContent guest DM policy", () => {
  it("should disable the composer with the reason when the guest DM policy closes the DM", () => {
    renderDm("off")

    expect(composerState()).toEqual({ disabled: "true", reason: GUEST_DM_READ_ONLY_REASON })
  })

  it("should leave the composer enabled when the guest DM policy is open", () => {
    renderDm("open")

    expect(composerState()).toEqual({ disabled: "false", reason: "" })
  })

  it("should leave the composer enabled in a DM between members whatever the policy is", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      viewer,
      { ...guest, role: "member" },
    ] as StoreUsers)

    renderDm("off")

    expect(composerState()).toEqual({ disabled: "false", reason: "" })
  })

  it("should leave the composer enabled for an admin and disable it for a member when only admins may DM guests", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { ...viewer, role: "admin" },
      guest,
    ] as StoreUsers)
    const { unmount } = renderDm("admins")
    const asAdmin = composerState()
    unmount()

    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([viewer, guest] as StoreUsers)
    renderDm("admins")

    expect({ asAdmin, asMember: composerState() }).toEqual({
      asAdmin: { disabled: "false", reason: "" },
      asMember: { disabled: "true", reason: GUEST_DM_READ_ONLY_REASON },
    })
  })

  it("should disable the composer of a thread under a closed DM", () => {
    const thread = createMockStream({
      id: "stream_dm_thread",
      type: StreamTypes.THREAD,
      workspaceId: WORKSPACE_ID,
      rootStreamId: DM_STREAM.id,
    })

    renderDm("off", thread)

    expect(composerState()).toEqual({ disabled: "true", reason: GUEST_DM_READ_ONLY_REASON })
  })
})
