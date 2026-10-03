import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { StreamConnectionErrorCodes, StreamTypes, type Stream, type StreamConnection } from "@threahq/types"
import { act, render, screen, userEvent, waitFor } from "@/test"
import { clearStreamConnections, clearWorkspaceActorTables, seedWorkspaceUser } from "@/test/workspace-rows"
import { ApiError } from "@/api/client"
import { streamConnectionsApi } from "@/api/stream-connections"
import * as contextsModule from "@/contexts"
import { putStreamConnection } from "@/stores/stream-connections-store"
import { ConnectTab } from "./connect-tab"

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_design",
    workspaceId: "ws_host",
    type: StreamTypes.CHANNEL,
    displayName: null,
    slug: "design",
    description: null,
    visibility: "public",
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  }
}

function makeConnection(overrides: Partial<StreamConnection> = {}): StreamConnection {
  return {
    id: "strconn_1",
    role: "host",
    state: "invited",
    revision: 1,
    streamId: "stream_design",
    remoteWorkspaceId: null,
    remoteWorkspaceName: null,
    partnerVisibility: null,
    invitedBy: "user_1",
    acceptedBy: null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

function makePartner(id: string, name: string): StreamConnection {
  return makeConnection({
    id,
    state: "active",
    revision: 2,
    remoteWorkspaceId: `ws_${name.toLowerCase()}`,
    remoteWorkspaceName: name,
  })
}

const WAITING = "Waiting for a workspace to accept."

/** Holds created links the way the settings dialog does, so they outlive the tab. */
function DialogHarness({ stream, showTab }: { stream: Stream; showTab: boolean }) {
  const [inviteLinks, setInviteLinks] = useState<ReadonlyMap<string, string>>(() => new Map())
  if (!showTab) return null
  return (
    <ConnectTab
      workspaceId="ws_host"
      stream={stream}
      inviteLinks={inviteLinks}
      onInviteLinkCreated={(connectionId, url) => setInviteLinks((links) => new Map(links).set(connectionId, url))}
    />
  )
}

function renderTab(stream = makeStream()) {
  const view = render(<DialogHarness stream={stream} showTab />)
  return {
    hideTab: () => view.rerender(<DialogHarness stream={stream} showTab={false} />),
    showTab: () => view.rerender(<DialogHarness stream={stream} showTab />),
  }
}

/** A partner's accept, or any other change, reaching this device over the socket. */
async function receiveUpdate(connection: StreamConnection) {
  await act(() => putStreamConnection("ws_host", connection))
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")

describe("ConnectTab", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { timeFormat: "24h" },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    await clearStreamConnections()
    await clearWorkspaceActorTables()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
    else Reflect.deleteProperty(navigator, "clipboard")
  })

  it("should show the new link once and let the admin copy it when they create an invite", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([])
    const createInvite = vi
      .spyOn(streamConnectionsApi, "createInvite")
      .mockResolvedValue({ connection: makeConnection(), token: "tok_secret" })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))

    const link = await screen.findByLabelText("Invite link")
    expect(createInvite).toHaveBeenCalledWith("ws_host", "stream_design")
    expect(link).toHaveValue(`${window.location.origin}/connections/tok_secret`)
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/connections/tok_secret`)
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument()
  })

  it("should keep the new link when the admin leaves the tab and comes back", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection()])
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection(),
      token: "tok_secret",
    })

    const tab = renderTab()
    await screen.findByText(WAITING)
    await userEvent.click(screen.getByRole("button", { name: "Create invite link" }))
    await screen.findByLabelText("Invite link")
    tab.hideTab()
    tab.showTab()

    expect(await screen.findByLabelText("Invite link")).toHaveValue(`${window.location.origin}/connections/tok_secret`)
  })

  it("should show a pending invite without its link, naming who created it, when the tab opens later", async () => {
    await seedWorkspaceUser("ws_host", "user_1", "Kris")
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection()])

    renderTab()

    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    expect(await screen.findByText(/^Created by Kris\. Expires /)).toBeInTheDocument()
    expect(screen.queryByLabelText("Invite link")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument()
  })

  it("should return to the share prompt when the admin revokes the pending invite", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection()])
    const revoke = vi
      .spyOn(streamConnectionsApi, "revoke")
      .mockResolvedValue(makeConnection({ state: "revoked", revision: 2 }))

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }))

    await waitFor(() => expect(screen.queryByText(WAITING)).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeEnabled()
    expect(revoke).toHaveBeenCalledWith("ws_host", "strconn_1")
  })

  it("should list every connected workspace and every pending invite, newest first, when the channel has several", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 9, 1, 10, 0))
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makePartner("strconn_1", "Beta"),
      makePartner("strconn_2", "Gamma"),
      makeConnection({ id: "strconn_3", expiresAt: new Date(2026, 9, 1, 10, 30).toISOString() }),
      makeConnection({ id: "strconn_4", expiresAt: new Date(2026, 9, 1, 10, 45).toISOString() }),
    ])

    renderTab()

    await screen.findByText("Beta")
    expect({
      rows: screen.getAllByRole("listitem").map((item) => item.textContent),
      createLink: screen.getByRole("button", { name: "Create invite link" }).hasAttribute("disabled"),
    }).toEqual({
      rows: ["Gamma", "Beta", `${WAITING}Expires 10:45.Revoke`, `${WAITING}Expires 10:30.Revoke`],
      createLink: false,
    })
  })

  it("should leave only the share prompt when every invite has expired", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makeConnection({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ])

    renderTab()

    expect(await screen.findByRole("button", { name: "Create invite link" })).toBeInTheDocument()
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument()
  })

  it("should drop an invite from the list when it expires while the tab is open", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makeConnection({ expiresAt: new Date(Date.now() + 300).toISOString() }),
    ])

    renderTab()

    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(WAITING)).not.toBeInTheDocument(), { timeout: 2_000 })
    expect(screen.getByText("Share with another workspace")).toBeInTheDocument()
  })

  it("should revoke only the chosen link and keep the other pending invites", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makeConnection({ id: "strconn_1" }),
      makeConnection({ id: "strconn_2" }),
      makeConnection({ id: "strconn_3" }),
    ])
    const revoke = vi
      .spyOn(streamConnectionsApi, "revoke")
      .mockResolvedValue(makeConnection({ id: "strconn_2", state: "revoked", revision: 2 }))

    renderTab()
    await userEvent.click((await screen.findAllByRole("button", { name: "Revoke" }))[1])

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2))
    expect({ revoked: revoke.mock.calls, waiting: screen.getAllByText(WAITING).length }).toEqual({
      revoked: [["ws_host", "strconn_2"]],
      waiting: 2,
    })
  })

  it("should mark only the link being revoked and hold the other actions until it's gone", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makeConnection({ id: "strconn_1" }),
      makeConnection({ id: "strconn_2" }),
    ])
    let finishRevoke!: (connection: StreamConnection) => void
    vi.spyOn(streamConnectionsApi, "revoke").mockReturnValue(new Promise((resolve) => (finishRevoke = resolve)))

    renderTab()
    await userEvent.click((await screen.findAllByRole("button", { name: "Revoke" }))[1])

    await screen.findByRole("button", { name: "Revoking…" })
    expect(
      screen.getAllByRole("button").map((button) => [button.textContent, button.hasAttribute("disabled")])
    ).toEqual([
      ["Revoke", true],
      ["Revoking…", true],
      ["Create invite link", true],
    ])
    await act(async () => finishRevoke(makeConnection({ id: "strconn_1", state: "revoked", revision: 2 })))
    await waitFor(() => expect(screen.getByRole("button", { name: "Create invite link" })).toBeEnabled())
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1)
  })

  it("should add the new link above the pending invites when the admin creates another", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection({ id: "strconn_1" })])
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "strconn_2" }),
      token: "tok_2",
    })

    renderTab()
    await screen.findByText(WAITING)
    await userEvent.click(screen.getByRole("button", { name: "Create invite link" }))

    await screen.findByLabelText("Invite link")
    const invites = screen.getAllByRole("listitem")
    expect({
      first: (invites[0].querySelector("input") as HTMLInputElement | null)?.value,
      second: invites[1].textContent?.startsWith(WAITING),
    }).toEqual({ first: `${window.location.origin}/connections/tok_2`, second: true })
  })

  it("should keep the connected workspaces when the admin creates another invite", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makePartner("strconn_1", "Beta")])
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "strconn_2" }),
      token: "tok_2",
    })

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))

    expect(await screen.findByLabelText("Invite link")).toHaveValue(`${window.location.origin}/connections/tok_2`)
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeEnabled()
  })

  it("should keep the new link when the admin revokes a different invite", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection({ id: "strconn_1" })])
    const revoke = vi
      .spyOn(streamConnectionsApi, "revoke")
      .mockResolvedValue(makeConnection({ id: "strconn_1", state: "revoked", revision: 2 }))
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "strconn_2" }),
      token: "tok_2",
    })

    renderTab()
    await screen.findByText(WAITING)
    await userEvent.click(screen.getByRole("button", { name: "Create invite link" }))
    await screen.findByLabelText("Invite link")
    await userEvent.click(screen.getAllByRole("button", { name: "Revoke" })[1])

    await waitFor(() => expect(screen.queryByText(WAITING)).not.toBeInTheDocument())
    expect({
      revoked: revoke.mock.calls,
      link: (screen.getByLabelText("Invite link") as HTMLInputElement).value,
      revokeButtons: screen.getAllByRole("button", { name: "Revoke" }).length,
    }).toEqual({
      revoked: [["ws_host", "strconn_1"]],
      link: `${window.location.origin}/connections/tok_2`,
      revokeButtons: 1,
    })
  })

  it("should drop the link and keep the other invites when the admin revokes the one just created", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection({ id: "strconn_1" })])
    const revoke = vi
      .spyOn(streamConnectionsApi, "revoke")
      .mockResolvedValue(makeConnection({ id: "strconn_2", state: "revoked", revision: 2 }))
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "strconn_2" }),
      token: "tok_2",
    })

    renderTab()
    await screen.findByText(WAITING)
    await userEvent.click(screen.getByRole("button", { name: "Create invite link" }))
    await screen.findByLabelText("Invite link")
    await userEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0])

    await waitFor(() => expect(screen.queryByLabelText("Invite link")).not.toBeInTheDocument())
    expect({ revoked: revoke.mock.calls, waiting: screen.getAllByText(WAITING).length }).toEqual({
      revoked: [["ws_host", "strconn_2"]],
      waiting: 1,
    })
  })

  it("should name every partner workspace when the channel is shared", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makePartner("strconn_1", "Beta"),
      makePartner("strconn_2", "Gamma"),
    ])

    renderTab()

    expect(await screen.findByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Gamma")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeEnabled()
  })

  it("should still list the partners and explain why there is no new link when the shared channel is archived", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makePartner("strconn_1", "Beta")])

    renderTab(makeStream({ archivedAt: "2026-10-01T12:00:00.000Z" }))

    expect(await screen.findByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Archived channels can't be shared.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create invite link" })).not.toBeInTheDocument()
  })

  it("should explain why an encrypted channel can't be shared instead of offering a link", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([])

    renderTab(makeStream({ e2eEnabled: true }))

    expect(await screen.findByText("Encrypted channels can't be shared.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create invite link" })).not.toBeInTheDocument()
  })

  it("should explain why an archived channel can't be shared instead of offering a link", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([])

    renderTab(makeStream({ archivedAt: "2026-10-01T12:00:00.000Z" }))

    expect(await screen.findByText("Archived channels can't be shared.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create invite link" })).not.toBeInTheDocument()
  })

  it.each([
    {
      error: new ApiError(409, StreamConnectionErrorCodes.NOT_SHAREABLE, "not shareable"),
      message: "Only active, unencrypted channels can be shared.",
    },
    { error: new ApiError(500, "INTERNAL", "boom"), message: "Couldn't create the link. Try again." },
  ])("should say why creating the link failed and let the admin retry ($error.code)", async ({ error, message }) => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([])
    vi.spyOn(streamConnectionsApi, "createInvite").mockRejectedValue(error)

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))

    const alert = await screen.findByRole("alert")
    const button = screen.getByRole("button", { name: "Create invite link" })
    expect({
      message: alert.textContent,
      besideButton: button.parentElement === alert.parentElement,
      buttonEnabled: !button.hasAttribute("disabled"),
    }).toEqual({ message, besideButton: true, buttonEnabled: true })
  })

  it("should ask the admin to copy the link by hand when the clipboard refuses", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([])
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection(),
      token: "tok_secret",
    })
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't copy the link. Select it and copy it yourself."
    )
    expect(screen.getByLabelText("Invite link")).toHaveValue(`${window.location.origin}/connections/tok_secret`)
  })

  it("should keep the new link when the tab's load started before the create and lands after it", async () => {
    await putStreamConnection("ws_host", makePartner("strconn_1", "Beta"))
    let landLoad!: (connections: StreamConnection[]) => void
    vi.spyOn(streamConnectionsApi, "list").mockReturnValue(new Promise((resolve) => (landLoad = resolve)))
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "strconn_2" }),
      token: "tok_secret",
    })

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))
    await screen.findByLabelText("Invite link")
    await act(async () => landLoad([makePartner("strconn_1", "Beta")]))

    expect(screen.getByLabelText("Invite link")).toHaveValue(`${window.location.origin}/connections/tok_secret`)
    expect(screen.getByText("Beta")).toBeInTheDocument()
  })

  it("should drop a cached invite the load no longer lists", async () => {
    await putStreamConnection("ws_host", makeConnection())
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makePartner("strconn_2", "Gamma")])

    renderTab()

    expect(await screen.findByText("Gamma")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(WAITING)).not.toBeInTheDocument())
  })

  it("should give the expiry as a clock time once the invite is in its last hour", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 9, 1, 10, 0))
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makeConnection({ expiresAt: new Date(2026, 9, 1, 10, 30).toISOString() }),
    ])

    renderTab()

    expect(await screen.findByText("Expires 10:30.")).toBeInTheDocument()
  })

  it("should list the partner and say they accepted first when a revoke races their accept", async () => {
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makeConnection()])
      .mockResolvedValue([makePartner("strconn_1", "Beta")])
    vi.spyOn(streamConnectionsApi, "revoke").mockRejectedValue(
      new ApiError(409, StreamConnectionErrorCodes.ALREADY_ACCEPTED, "already accepted")
    )

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }))

    const alert = await screen.findByRole("alert")
    const partner = screen.getByText("Beta")
    expect({
      message: alert.textContent,
      aboveLists: Boolean(alert.compareDocumentPosition(partner) & Node.DOCUMENT_POSITION_FOLLOWING),
      revoke: screen.queryByRole("button", { name: "Revoke" }),
    }).toEqual({ message: "Another workspace already accepted this invite.", aboveLists: true, revoke: null })
  })

  it("should drop the link and say it's gone when the admin revokes one that no longer exists", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValueOnce([makeConnection()]).mockResolvedValue([])
    vi.spyOn(streamConnectionsApi, "revoke").mockRejectedValue(
      new ApiError(404, StreamConnectionErrorCodes.NOT_FOUND, "not found")
    )

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("This link no longer exists.")
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument())
  })

  it("should show the partner as soon as their accept reaches this device", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection()])

    renderTab()
    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    await receiveUpdate(makePartner("strconn_1", "Beta"))

    expect(await screen.findByText("Beta")).toBeInTheDocument()
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
  })

  it("should show a second partner as soon as they accept while another partner is already connected", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makePartner("strconn_1", "Beta"),
      makeConnection({ id: "strconn_2" }),
    ])

    renderTab()
    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    await receiveUpdate(makePartner("strconn_2", "Gamma"))

    expect(await screen.findByText("Gamma")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
  })

  it("should load the connections again when the admin retries a failed load", async () => {
    vi.spyOn(streamConnectionsApi, "list")
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL", "boom"))
      .mockResolvedValue([])

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }))

    expect(await screen.findByRole("button", { name: "Create invite link" })).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("should load the connections again after the socket reconnects, keeping the current ones on screen meanwhile", async () => {
    let reconnects = 0
    vi.spyOn(contextsModule, "useSocketReconnectCount").mockImplementation(() => reconnects)
    let finishReload!: (connections: StreamConnection[]) => void
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makeConnection()])
      .mockReturnValue(new Promise((resolve) => (finishReload = resolve)))

    const tab = renderTab()
    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    reconnects = 1
    tab.showTab()

    await waitFor(() => expect(streamConnectionsApi.list).toHaveBeenCalledTimes(2))
    expect(screen.getByText(WAITING)).toBeInTheDocument()
    await act(async () => finishReload([makePartner("strconn_1", "Beta")]))

    expect(await screen.findByText("Beta")).toBeInTheDocument()
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
  })

  it("should keep showing the cached invites and offer a retry when the load fails", async () => {
    await putStreamConnection("ws_host", makeConnection())
    vi.spyOn(streamConnectionsApi, "list").mockRejectedValue(new ApiError(500, "INTERNAL", "boom"))

    renderTab()

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this channel's connections.")
    expect(screen.getByText(WAITING)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  })
})
