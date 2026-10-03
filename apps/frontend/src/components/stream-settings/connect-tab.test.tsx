import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamConnectionErrorCodes, StreamTypes, type Stream, type StreamConnection } from "@threahq/types"
import { act, render, screen, userEvent, waitFor } from "@/test"
import { ApiError } from "@/api/client"
import { streamConnectionsApi } from "@/api/stream-connections"
import * as contextsModule from "@/contexts"
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
    id: "sconn_1",
    role: "host",
    state: "invited",
    streamId: "stream_design",
    streamSlug: "design",
    streamDisplayName: null,
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
    remoteWorkspaceId: `ws_${name.toLowerCase()}`,
    remoteWorkspaceName: name,
  })
}

const WAITING = "Waiting for a workspace to accept."

function renderTab(stream = makeStream()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectTab workspaceId="ws_host" stream={stream} />
    </QueryClientProvider>
  )
  return queryClient
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")

describe("ConnectTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { timeFormat: "24h" },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
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

  it("should show a pending invite without its link when the tab reopens", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection()])

    renderTab()

    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    expect(screen.queryByLabelText("Invite link")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument()
  })

  it("should return to the share prompt when the admin revokes the pending invite", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValueOnce([makeConnection()]).mockResolvedValue([])
    const revoke = vi.spyOn(streamConnectionsApi, "revoke").mockResolvedValue(makeConnection({ state: "revoked" }))

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }))

    expect(await screen.findByRole("button", { name: "Create invite link" })).toBeInTheDocument()
    expect(revoke).toHaveBeenCalledWith("ws_host", "sconn_1")
  })

  it("should list every connected workspace and every pending invite when the channel has several", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 9, 1, 10, 0))
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makePartner("sconn_beta", "Beta"),
      makePartner("sconn_gamma", "Gamma"),
      makeConnection({ id: "sconn_a", expiresAt: new Date(2026, 9, 1, 10, 30).toISOString() }),
      makeConnection({ id: "sconn_b", expiresAt: new Date(2026, 9, 1, 10, 45).toISOString() }),
    ])

    renderTab()

    const items = await screen.findAllByRole("listitem")
    expect({
      rows: items.map((item) => item.textContent),
      createLink: screen.getByRole("button", { name: "Create invite link" }).hasAttribute("disabled"),
    }).toEqual({
      rows: ["Beta", "Gamma", `${WAITING}Expires 10:30.Revoke`, `${WAITING}Expires 10:45.Revoke`],
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

  it("should revoke only the chosen link and keep the other pending invites", async () => {
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([
        makeConnection({ id: "sconn_a" }),
        makeConnection({ id: "sconn_b" }),
        makeConnection({ id: "sconn_c" }),
      ])
      .mockResolvedValue([makeConnection({ id: "sconn_a" }), makeConnection({ id: "sconn_c" })])
    const revoke = vi.spyOn(streamConnectionsApi, "revoke").mockResolvedValue(makeConnection({ state: "revoked" }))

    renderTab()
    await userEvent.click((await screen.findAllByRole("button", { name: "Revoke" }))[1])

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2))
    expect({ revoked: revoke.mock.calls, waiting: screen.getAllByText(WAITING).length }).toEqual({
      revoked: [["ws_host", "sconn_b"]],
      waiting: 2,
    })
  })

  it("should mark only the link being revoked and hold the other actions until it's gone", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makeConnection({ id: "sconn_a" }),
      makeConnection({ id: "sconn_b" }),
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
    await act(async () => finishRevoke(makeConnection({ state: "revoked" })))
    await waitFor(() => expect(screen.getByRole("button", { name: "Create invite link" })).toBeEnabled())
  })

  it("should add the new link above the pending invites when the admin creates another", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection({ id: "sconn_a" })])
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "sconn_b" }),
      token: "tok_b",
    })

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))

    const link = await screen.findByLabelText("Invite link")
    expect({
      link: (link as HTMLInputElement).value,
      revokeButtons: screen.getAllByRole("button", { name: "Revoke" }).length,
      waiting: screen.getAllByText(WAITING).length,
    }).toEqual({ link: `${window.location.origin}/connections/tok_b`, revokeButtons: 2, waiting: 1 })
  })

  it("should keep the connected workspaces when the admin creates another invite", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makePartner("sconn_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "sconn_b" }),
      token: "tok_b",
    })

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))

    expect(await screen.findByLabelText("Invite link")).toHaveValue(`${window.location.origin}/connections/tok_b`)
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeEnabled()
  })

  it("should keep the new link when the admin revokes a different invite", async () => {
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makeConnection({ id: "sconn_a" })])
      .mockResolvedValue([makeConnection({ id: "sconn_b" })])
    const revoke = vi.spyOn(streamConnectionsApi, "revoke").mockResolvedValue(makeConnection({ state: "revoked" }))
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "sconn_b" }),
      token: "tok_b",
    })

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))
    await screen.findByLabelText("Invite link")
    await userEvent.click(screen.getAllByRole("button", { name: "Revoke" })[1])

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1))
    expect({
      revoked: revoke.mock.calls,
      link: (screen.getByLabelText("Invite link") as HTMLInputElement).value,
      waiting: screen.queryByText(WAITING),
    }).toEqual({
      revoked: [["ws_host", "sconn_a"]],
      link: `${window.location.origin}/connections/tok_b`,
      waiting: null,
    })
  })

  it("should drop the link and keep the other invites when the admin revokes the one just created", async () => {
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makeConnection({ id: "sconn_a" })])
      .mockResolvedValue([makeConnection({ id: "sconn_a" })])
    const revoke = vi.spyOn(streamConnectionsApi, "revoke").mockResolvedValue(makeConnection({ state: "revoked" }))
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection({ id: "sconn_b" }),
      token: "tok_b",
    })

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))
    await screen.findByLabelText("Invite link")
    await userEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0])

    await waitFor(() => expect(screen.queryByLabelText("Invite link")).not.toBeInTheDocument())
    expect({ revoked: revoke.mock.calls, waiting: screen.getAllByText(WAITING).length }).toEqual({
      revoked: [["ws_host", "sconn_b"]],
      waiting: 1,
    })
  })

  it("should name every partner workspace when the channel is shared", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makePartner("sconn_beta", "Beta"),
      makePartner("sconn_gamma", "Gamma"),
    ])

    renderTab()

    expect(await screen.findByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Gamma")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeEnabled()
  })

  it("should still list the partners and explain why there is no new link when the shared channel is archived", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makePartner("sconn_beta", "Beta")])

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

    expect(await screen.findByRole("alert")).toHaveTextContent(message)
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeEnabled()
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

  it("should keep the new link when a refresh that started before the create lands after it", async () => {
    let landStaleList!: (connections: StreamConnection[]) => void
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(new Promise((resolve) => (landStaleList = resolve)))
    vi.spyOn(streamConnectionsApi, "createInvite").mockResolvedValue({
      connection: makeConnection(),
      token: "tok_secret",
    })

    const queryClient = renderTab()
    const createButton = await screen.findByRole("button", { name: "Create invite link" })
    const staleRefresh = queryClient.refetchQueries()
    await userEvent.click(createButton)
    expect(await screen.findByLabelText("Invite link")).toBeInTheDocument()
    await act(async () => {
      landStaleList([])
      await staleRefresh
      // React Query notifies observers on a timer; let the landed list render.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByLabelText("Invite link")).toHaveValue(`${window.location.origin}/connections/tok_secret`)
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

  it("should list the partner when a revoke races their accept", async () => {
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makeConnection()])
      .mockResolvedValue([makePartner("sconn_1", "Beta")])
    vi.spyOn(streamConnectionsApi, "revoke").mockRejectedValue(
      new ApiError(409, StreamConnectionErrorCodes.ALREADY_ACCEPTED, "already accepted")
    )

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }))

    expect(await screen.findByText("Beta")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument()
  })

  it("should say another workspace accepted the invite when the refresh hasn't caught up with the accept", async () => {
    const list = vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection()])
    vi.spyOn(streamConnectionsApi, "revoke").mockRejectedValue(
      new ApiError(409, StreamConnectionErrorCodes.ALREADY_ACCEPTED, "already accepted")
    )

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Another workspace already accepted this invite.")
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it("should show the partner once they accept while the pending invite is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makeConnection()])
      .mockResolvedValue([makePartner("sconn_1", "Beta")])

    renderTab()
    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(await screen.findByText("Beta")).toBeInTheDocument()
  })

  it("should show a second partner once they accept while another partner is already connected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makePartner("sconn_beta", "Beta"), makeConnection({ id: "sconn_b" })])
      .mockResolvedValue([makePartner("sconn_beta", "Beta"), makePartner("sconn_b", "Gamma")])

    renderTab()
    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(await screen.findByText("Gamma")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
  })

  it("should stop polling once the last pending invite is accepted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const list = vi
      .spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makeConnection()])
      .mockResolvedValue([makePartner("sconn_1", "Beta")])

    renderTab()
    await screen.findByText(WAITING)
    await vi.advanceTimersByTimeAsync(15_000)
    await screen.findByText("Beta")
    await vi.advanceTimersByTimeAsync(60_000)

    expect(list).toHaveBeenCalledTimes(2)
  })

  it("should not poll when the channel has no pending invite", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const list = vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makePartner("sconn_beta", "Beta")])

    renderTab()
    await screen.findByText("Beta")
    await vi.advanceTimersByTimeAsync(60_000)

    expect(list).toHaveBeenCalledTimes(1)
  })

  it("should load the connections again when the admin retries a failed load", async () => {
    vi.spyOn(streamConnectionsApi, "list")
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL", "boom"))
      .mockResolvedValue([])

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }))

    expect(await screen.findByRole("button", { name: "Create invite link" })).toBeInTheDocument()
  })

  it("should keep showing the pending invite when a background refresh fails", async () => {
    const list = vi
      .spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([makeConnection()])
      .mockRejectedValue(new ApiError(500, "INTERNAL", "boom"))

    const queryClient = renderTab()
    expect(await screen.findByText(WAITING)).toBeInTheDocument()
    await queryClient.refetchQueries()
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(list).toHaveBeenCalledTimes(2)
    expect(screen.getByText(WAITING)).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
