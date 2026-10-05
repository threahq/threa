import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, WORKSPACE_PERMISSION_SCOPES, type Stream, type StreamBootstrap } from "@threahq/types"
import * as hooksModule from "@/hooks"
import { streamKeys } from "@/hooks"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import { StreamSettingsDialog } from "./stream-settings-dialog"
import * as useStreamSettingsModule from "./use-stream-settings"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as generalTabModule from "./general-tab"
import * as companionTabModule from "./companion-tab"
import * as membersTabModule from "./members-tab"
import * as connectTabModule from "./connect-tab"
import * as useCurrentWorkspaceUserIdModule from "@/hooks/use-current-workspace-user-id"

const useStreamSettingsMock = vi.fn()
const useWorkspaceStreamsMock = vi.fn()
const useWorkspaceStreamMembershipsMock = vi.fn()
const closeStreamSettings = vi.fn()
const setTab = vi.fn()

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_dm",
    workspaceId: "ws_1",
    type: StreamTypes.DM,
    displayName: "Direct chat",
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  }
}

describe("StreamSettingsDialog", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.restoreAllMocks()
    useStreamSettingsMock.mockReset()
    useWorkspaceStreamsMock.mockReset()
    useWorkspaceStreamMembershipsMock.mockReset()
    closeStreamSettings.mockReset()
    setTab.mockReset()

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })

    useStreamSettingsMock.mockReturnValue({
      isOpen: true,
      activeTab: "general",
      streamId: "stream_dm",
      closeStreamSettings,
      setTab,
    })

    const stream = makeStream()
    const bootstrap: StreamBootstrap = {
      stream,
      events: [],
      members: [],
      botMemberIds: [],
      connectedWorkspaceIds: [],
      membership: null,
      latestSequence: "0",
      hasOlderEvents: false,
      syncMode: "replace",
      unreadCount: 0,
      mentionCount: 0,
      activityCount: 0,
    }

    queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_dm"), bootstrap)

    useWorkspaceStreamsMock.mockReturnValue([])
    useWorkspaceStreamMembershipsMock.mockReturnValue([
      {
        streamId: "stream_dm",
        memberId: "user_1",
        notificationLevel: "activity",
      },
    ])

    vi.spyOn(useStreamSettingsModule, "useStreamSettings").mockImplementation((() =>
      useStreamSettingsMock()) as unknown as typeof useStreamSettingsModule.useStreamSettings)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockImplementation(((...args: unknown[]) =>
      useWorkspaceStreamsMock(...args)) as unknown as typeof workspaceStoreModule.useWorkspaceStreams)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockImplementation(((...args: unknown[]) =>
      useWorkspaceStreamMembershipsMock(
        ...args
      )) as unknown as typeof workspaceStoreModule.useWorkspaceStreamMemberships)

    vi.spyOn(generalTabModule, "GeneralTab").mockImplementation((() => (
      <div>General panel</div>
    )) as unknown as typeof generalTabModule.GeneralTab)
    vi.spyOn(companionTabModule, "CompanionTab").mockImplementation((() => (
      <div>Companion panel</div>
    )) as unknown as typeof companionTabModule.CompanionTab)
    vi.spyOn(membersTabModule, "MembersTab").mockImplementation((() => (
      <div>Members panel</div>
    )) as unknown as typeof membersTabModule.MembersTab)
    vi.spyOn(useCurrentWorkspaceUserIdModule, "useCurrentWorkspaceUserId").mockReturnValue("user_1")
  })

  it("shows only the available sidebar items for the resolved stream type", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <StreamSettingsDialog workspaceId="ws_1" />
      </QueryClientProvider>
    )

    expect(await screen.findByText("Direct chat Settings")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /General/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Companion/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Members/i })).toBeInTheDocument()
    expect(screen.getByText("Notifications and stream details")).toBeInTheDocument()
    expect(screen.getByText("General panel")).toBeVisible()

    const tabs = document.body.querySelector('[data-slot="settings-tabs"]')
    const panels = document.body.querySelector('[data-slot="settings-panels"]')
    const nav = document.body.querySelector('[data-slot="settings-nav"]')
    const content = document.body.querySelector('[data-slot="settings-content"]')

    expect(tabs).toHaveClass("flex", "flex-1", "min-h-0", "flex-col")
    expect(panels).toHaveClass("flex", "flex-1", "min-h-0", "overflow-hidden")
    expect(nav).toHaveClass("min-h-0", "overflow-y-auto")
    expect(content).toHaveClass("flex-1", "min-h-0", "overflow-y-auto")
  })

  it("opens for an archived stream with no membership row (the only unarchive affordance)", async () => {
    // Memberships aren't bootstrapped for archived streams, so after a reload
    // the archived row exists in the stream cache but no membership does. The
    // dialog must still open — gating the viewer id on the membership row left
    // it stuck on the loading state, with no other way to unarchive.
    useStreamSettingsMock.mockReturnValue({
      isOpen: true,
      activeTab: "general",
      streamId: "stream_archived",
      closeStreamSettings,
      setTab,
    })
    useWorkspaceStreamsMock.mockReturnValue([
      makeStream({
        id: "stream_archived",
        type: StreamTypes.CHANNEL,
        displayName: "Old Channel",
        slug: "old-channel",
        archivedAt: "2026-03-01T00:00:00.000Z",
      }),
    ])
    useWorkspaceStreamMembershipsMock.mockReturnValue([])

    render(
      <QueryClientProvider client={queryClient}>
        <StreamSettingsDialog workspaceId="ws_1" />
      </QueryClientProvider>
    )

    expect(await screen.findByText("General panel")).toBeVisible()
    expect(screen.queryByText(/Loading stream settings/i)).not.toBeInTheDocument()
  })

  it.each([
    { type: StreamTypes.CHANNEL, flag: "on", admin: true, shown: true },
    { type: StreamTypes.CHANNEL, flag: "off", admin: true, shown: false },
    { type: StreamTypes.CHANNEL, flag: "on", admin: false, shown: false },
    { type: StreamTypes.SCRATCHPAD, flag: "on", admin: true, shown: false },
    { type: StreamTypes.DM, flag: "on", admin: true, shown: false },
    { type: StreamTypes.THREAD, flag: "on", admin: true, shown: false },
  ] as const)(
    "should offer Connect only on a channel, to an admin with the flag on ($type, $flag, admin $admin)",
    async ({ type, flag, admin, shown }) => {
      useStreamSettingsMock.mockReturnValue({
        isOpen: true,
        activeTab: "connect",
        streamId: "stream_design",
        closeStreamSettings,
        setTab,
      })
      useWorkspaceStreamsMock.mockReturnValue([
        makeStream({ id: "stream_design", type, displayName: null, slug: "design" }),
      ])
      vi.spyOn(hooksModule, "useFeatureFlag").mockReturnValue(flag as never)
      vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue(
        admin ? [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN] : []
      )
      vi.spyOn(connectTabModule, "ConnectTab").mockImplementation((() => (
        <div>Connect panel</div>
      )) as unknown as typeof connectTabModule.ConnectTab)

      render(
        <QueryClientProvider client={queryClient}>
          <StreamSettingsDialog workspaceId="ws_1" />
        </QueryClientProvider>
      )

      expect(await screen.findByRole("button", { name: /General/i })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /Connect/i }) !== null).toBe(shown)
      expect(screen.queryByText(shown ? "Connect panel" : "General panel")).toBeVisible()
    }
  )

  it("titles a DM with the resolved peer name when the stream row has no displayName", async () => {
    // Raw DM rows arrive with displayName: null (viewer-specific names aren't
    // persisted), so the title must resolve through the shared resolver via the
    // peer user rather than falling back to a generic label.
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_dm"), {
      stream: makeStream({ displayName: null }),
      events: [],
      members: [],
      botMemberIds: [],
      connectedWorkspaceIds: [],
      membership: null,
      latestSequence: "0",
      hasOlderEvents: false,
      syncMode: "replace",
      unreadCount: 0,
      mentionCount: 0,
      activityCount: 0,
    } satisfies StreamBootstrap)

    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { id: "user_peer", name: "Ada Lovelace" },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([
      { streamId: "stream_dm", userId: "user_peer" },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceDmPeers>)

    render(
      <QueryClientProvider client={queryClient}>
        <StreamSettingsDialog workspaceId="ws_1" />
      </QueryClientProvider>
    )

    expect(await screen.findByText("Ada Lovelace Settings")).toBeInTheDocument()
  })

  it("should keep a created invite link across tab switches and drop it once the dialog closes", async () => {
    const settings = (overrides: { isOpen?: boolean; activeTab?: string }) =>
      useStreamSettingsMock.mockReturnValue({
        isOpen: true,
        activeTab: "connect",
        streamId: "stream_design",
        closeStreamSettings,
        setTab,
        ...overrides,
      })
    settings({})
    useWorkspaceStreamsMock.mockReturnValue([
      makeStream({ id: "stream_design", type: StreamTypes.CHANNEL, displayName: null, slug: "design" }),
    ])
    vi.spyOn(hooksModule, "useFeatureFlag").mockReturnValue("on" as never)
    vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    let createLink!: () => void
    vi.spyOn(connectTabModule, "ConnectTab").mockImplementation((({
      inviteLinks,
      onInviteLinkCreated,
    }: Parameters<typeof connectTabModule.ConnectTab>[0]) => {
      createLink = () => onInviteLinkCreated("strconn_1", "https://app.example/connections/tok")
      return <div>{inviteLinks.get("strconn_1") ?? "No link"}</div>
    }) as unknown as typeof connectTabModule.ConnectTab)
    const dialog = () => (
      <QueryClientProvider client={queryClient}>
        <StreamSettingsDialog workspaceId="ws_1" />
      </QueryClientProvider>
    )

    const { rerender } = render(dialog())
    act(() => createLink())
    settings({ activeTab: "general" })
    rerender(dialog())
    settings({})
    rerender(dialog())
    const afterTabSwitch = screen.getByText(/connections\/tok|No link/).textContent
    settings({ isOpen: false })
    rerender(dialog())
    settings({})
    rerender(dialog())

    expect({ afterTabSwitch, afterReopen: (await screen.findByText(/connections\/tok|No link/)).textContent }).toEqual({
      afterTabSwitch: "https://app.example/connections/tok",
      afterReopen: "No link",
    })
  })
})
