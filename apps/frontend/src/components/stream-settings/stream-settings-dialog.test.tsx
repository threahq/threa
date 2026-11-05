import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { SettingsProvider } from "@/contexts"
import * as useMobileModule from "@/hooks/use-mobile"
import { StreamTypes, WORKSPACE_PERMISSION_SCOPES, type Stream, type StreamBootstrap } from "@threahq/types"
import * as hooksModule from "@/hooks"
import { streamKeys } from "@/hooks"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as generalTabModule from "./general-tab"
import * as companionTabModule from "./companion-tab"
import * as membersTabModule from "./members-tab"
import * as connectTabModule from "./connect-tab"
import * as useCurrentWorkspaceUserIdModule from "@/hooks/use-current-workspace-user-id"

const useWorkspaceStreamsMock = vi.fn()
const useWorkspaceStreamMembershipsMock = vi.fn()

function LocationProbe() {
  return (
    <>
      <output data-testid="location">{useLocation().search}</output>
      <Link to="?stream-settings=connect&sid=stream_design">Reopen connect</Link>
    </>
  )
}

function windowAt(search: string, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/ws_1/s/stream_dm${search}`]}>
        <Routes>
          <Route
            path="/w/:workspaceId/*"
            element={
              <SettingsProvider>
                <SettingsDialog />
                <LocationProbe />
              </SettingsProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** The window's nav: the stream's pages are its last group. */
function pages() {
  return screen.getByRole("list", { name: /^This stream/ })
}

function pageLinks(): string[] {
  return within(pages())
    .getAllByRole("link")
    .map((link) => link.textContent ?? "")
}

function seedBootstrap(queryClient: QueryClient, stream: Stream) {
  queryClient.setQueryData(streamKeys.bootstrap("ws_1", stream.id), {
    ...queryClient.getQueryData<StreamBootstrap>(streamKeys.bootstrap("ws_1", "stream_dm")),
    stream,
  })
}

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

describe("a stream's pages in the settings window", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.restoreAllMocks()
    useWorkspaceStreamsMock.mockReset()
    useWorkspaceStreamMembershipsMock.mockReset()

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })

    const stream = makeStream()
    const bootstrap: StreamBootstrap = {
      stream,
      events: [],
      members: [],
      botMemberIds: [],
      connectedWorkspaces: [],
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
      <div>Agent panel</div>
    )) as unknown as typeof companionTabModule.CompanionTab)
    vi.spyOn(membersTabModule, "MembersTab").mockImplementation((() => (
      <div>Members panel</div>
    )) as unknown as typeof membersTabModule.MembersTab)
    vi.spyOn(useCurrentWorkspaceUserIdModule, "useCurrentWorkspaceUserId").mockReturnValue("user_1")
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue([])
    vi.spyOn(useWorkspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
  })

  it.each([
    ["a top-level doc", null, ["General", "Stream members"]],
    ["a doc under a host", "stream_host", ["General"]],
  ])("should give %s its own pages", async (_label, parentStreamId, tabs) => {
    const doc = makeStream({ id: "stream_doc", type: StreamTypes.DOC, displayName: "Roadmap", parentStreamId })
    seedBootstrap(queryClient, doc)
    render(windowAt(`?stream-settings=general&sid=${doc.id}`, queryClient))

    await screen.findByRole("list", { name: "This stream · Roadmap" })
    expect(pageLinks()).toEqual(tabs)
  })

  it("shows the stream's pages as a third group beside yours and the workspace's, with the open one current", async () => {
    render(windowAt("?stream-settings=general&sid=stream_dm", queryClient))

    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    expect(within(nav).getByRole("list", { name: "You" })).toBeInTheDocument()
    expect(within(nav).getByRole("list", { name: "Workspace" })).toBeInTheDocument()
    expect(pageLinks()).toEqual(["General", "Agent", "Stream members"])
    expect(within(pages()).getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("heading", { name: "General", level: 2 })).toBeInTheDocument()
    expect(screen.getByText("This stream · Direct chat", { selector: "p" })).toBeInTheDocument()
    expect(screen.getByText("General panel")).toBeVisible()
  })

  it("opens a stream's bare link on its first page on desktop", async () => {
    render(windowAt("?stream-settings=&sid=stream_dm", queryClient))

    expect(await screen.findByText("General panel")).toBeVisible()
    expect(within(pages()).getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page")
  })

  it("moves from a stream page to one of yours and back in the same window", async () => {
    render(windowAt("?stream-settings=general&sid=stream_dm", queryClient))

    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    await userEvent.click(within(nav).getByRole("link", { name: "Overview" }))
    expect(screen.getByTestId("location").textContent).toBe("?sid=stream_dm&settings=")
    const streamGroup = await screen.findByRole("region", { name: "This stream · Direct chat" })
    await userEvent.click(within(streamGroup).getByRole("link", { name: /^Agent/ }))
    expect(screen.getByTestId("location").textContent).toBe("?sid=stream_dm&stream-settings=companion")
    expect(await screen.findByText("Agent panel")).toBeVisible()
  })

  it("switches pages through the URL from the page links", async () => {
    render(windowAt("?stream-settings=general&sid=stream_dm", queryClient))

    await userEvent.click(await within(pages()).findByRole("link", { name: "Agent" }))

    expect(screen.getByTestId("location").textContent).toBe("?stream-settings=companion&sid=stream_dm")
    expect(screen.getByText("Agent panel")).toBeVisible()
    expect(within(pages()).getByRole("link", { name: "Agent" })).toHaveAttribute("aria-current", "page")
  })

  it("lands on the setting a link names", async () => {
    vi.spyOn(generalTabModule, "GeneralTab").mockImplementation((() => (
      <div id="setting-stream-memory" tabIndex={-1}>
        Memory row
      </div>
    )) as unknown as typeof generalTabModule.GeneralTab)

    render(windowAt("?stream-settings=general&sid=stream_dm&setting=stream-memory", queryClient))

    const row = await screen.findByText("Memory row")
    await waitFor(() => expect(row).toHaveFocus())
    expect(row).toHaveAttribute("data-highlighted", "true")
  })

  it("finds this stream's settings from its search and opens them in place", async () => {
    render(windowAt("?stream-settings=general&sid=stream_dm", queryClient))

    await userEvent.type(await screen.findByRole("combobox", { name: /search/i }), "automatic memory")
    await userEvent.click(await screen.findByRole("option", { name: /Automatic memory/ }))

    expect(screen.getByTestId("location").textContent).toBe(
      "?stream-settings=general&sid=stream_dm&setting=stream-memory"
    )
  })

  it("opens on the one index on phones, scrolled to the stream's pages, with a way back to it from a page", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    // jsdom has no Element.scrollTo; the stream's group sits below the window's top.
    const scrollTo = vi.fn()
    Object.defineProperty(Element.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true })
    const rect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("aria-labelledby") === "settings-overview-stream"
        ? new DOMRect(0, 500, 300, 200)
        : rect.call(this)
    })
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollTo
    })
    render(windowAt("?stream-settings=&sid=stream_dm", queryClient))

    // vaul's drawer reads a transform jsdom doesn't compute on pointer release, so these are plain clicks.
    const streamGroup = await screen.findByRole("region", { name: "This stream · Direct chat" })
    const scopes = screen.getAllByRole("region").map((region) => region.getAttribute("aria-labelledby"))
    expect(scopes).toEqual(["settings-overview-stream", "settings-overview-you", "settings-overview-workspace"])
    expect(
      within(screen.getByRole("navigation", { name: "Settings scope" })).getByRole("button", { name: "This stream" })
    ).toBeInTheDocument()
    // Only the window's own scroll moves, never the drawer or page around it.
    const scroller = streamGroup.closest(".overflow-y-auto")
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 500 })))
    expect(new Set(scrollTo.mock.contexts)).toEqual(new Set([scroller]))
    fireEvent.click(within(streamGroup).getByRole("link", { name: /^Agent/ }))
    expect(await screen.findByText("Agent panel")).toBeVisible()

    fireEvent.click(screen.getByRole("link", { name: "All settings" }))
    expect(await screen.findByRole("region", { name: "This stream · Direct chat" })).toBeInTheDocument()
  })

  it("opens for an archived stream with no membership row (the only unarchive affordance)", async () => {
    // Memberships aren't bootstrapped for archived streams, so after a reload
    // the archived row exists in the stream cache but no membership does. The
    // dialog must still open — gating the viewer id on the membership row left
    // it stuck on the loading state, with no other way to unarchive.
    seedBootstrap(
      queryClient,
      makeStream({
        id: "stream_archived",
        type: StreamTypes.CHANNEL,
        displayName: "Old Channel",
        slug: "old-channel",
        archivedAt: "2026-03-01T00:00:00.000Z",
      })
    )
    useWorkspaceStreamMembershipsMock.mockReturnValue([])

    render(windowAt("?stream-settings=general&sid=stream_archived", queryClient))

    expect(await screen.findByText("General panel")).toBeVisible()
  })

  it.each([
    { type: StreamTypes.CHANNEL, flag: "on", admin: true, shown: true },
    { type: StreamTypes.CHANNEL, flag: "off", admin: true, shown: false },
    { type: StreamTypes.CHANNEL, flag: "on", admin: false, shown: false },
    { type: StreamTypes.SCRATCHPAD, flag: "on", admin: true, shown: false },
    { type: StreamTypes.DM, flag: "on", admin: true, shown: false },
    { type: StreamTypes.THREAD, flag: "on", admin: true, shown: false },
  ] as const)(
    "should offer Sharing only on a channel, to an admin with the flag on ($type, $flag, admin $admin)",
    async ({ type, flag, admin, shown }) => {
      seedBootstrap(queryClient, makeStream({ id: "stream_design", type, displayName: null, slug: "design" }))
      vi.spyOn(hooksModule, "useFeatureFlag").mockReturnValue(flag as never)
      vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue(
        admin ? [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN] : []
      )
      vi.spyOn(connectTabModule, "ConnectTab").mockImplementation((() => (
        <div>Connect panel</div>
      )) as unknown as typeof connectTabModule.ConnectTab)

      render(windowAt("?stream-settings=connect&sid=stream_design", queryClient))

      expect(await within(pages()).findByRole("link", { name: "General" })).toBeInTheDocument()
      expect(pageLinks().includes("Sharing")).toBe(shown)
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
      connectedWorkspaces: [],
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

    render(windowAt("?stream-settings=general&sid=stream_dm", queryClient))

    expect(await screen.findByRole("list", { name: "This stream · Ada Lovelace" })).toBeInTheDocument()
  })

  it("should keep a created invite link across page switches and drop it once the window closes", async () => {
    seedBootstrap(
      queryClient,
      makeStream({ id: "stream_design", type: StreamTypes.CHANNEL, displayName: null, slug: "design" })
    )
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

    render(windowAt("?stream-settings=connect&sid=stream_design", queryClient))
    await screen.findByText("No link")
    act(() => createLink())
    await userEvent.click(within(pages()).getByRole("link", { name: "General" }))
    await userEvent.click(within(pages()).getByRole("link", { name: "Sharing" }))
    const afterPageSwitch = screen.getByText(/connections\/tok|No link/).textContent
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }))
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""))
    await userEvent.click(screen.getByRole("link", { name: "Reopen connect" }))

    expect({ afterPageSwitch, afterReopen: (await screen.findByText(/connections\/tok|No link/)).textContent }).toEqual(
      {
        afterPageSwitch: "https://app.example/connections/tok",
        afterReopen: "No link",
      }
    )
  })
})
