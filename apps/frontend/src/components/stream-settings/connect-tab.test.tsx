import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, type Stream, type StreamConnection } from "@threahq/types"
import { render, screen, userEvent, waitFor } from "@/test"
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
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

function renderTab(stream = makeStream()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectTab workspaceId="ws_host" stream={stream} />
    </QueryClientProvider>
  )
}

describe("ConnectTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { timeFormat: "24h" },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
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

    expect(await screen.findByText("Waiting for another workspace to accept.")).toBeInTheDocument()
    expect(screen.queryByLabelText("Invite link")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument()
  })

  it("should return to the share prompt when the admin revokes the pending invite", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([makeConnection()])
    const revoke = vi.spyOn(streamConnectionsApi, "revoke").mockResolvedValue(makeConnection({ state: "revoked" }))

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }))

    expect(await screen.findByRole("button", { name: "Create invite link" })).toBeInTheDocument()
    expect(revoke).toHaveBeenCalledWith("ws_host", "sconn_1")
  })

  it("should offer only a new link when the pending invite has expired", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makeConnection({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ])

    renderTab()

    expect(await screen.findByText("This link has expired.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New link" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument()
  })

  it("should name the partner workspace when the channel is shared", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([
      makeConnection({ state: "active", remoteWorkspaceId: "ws_beta", remoteWorkspaceName: "Beta" }),
    ])

    renderTab()

    expect(await screen.findByText("Beta")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /link/i })).not.toBeInTheDocument()
  })

  it("should explain why an encrypted channel can't be shared instead of offering a link", async () => {
    vi.spyOn(streamConnectionsApi, "list").mockResolvedValue([])

    renderTab(makeStream({ e2eEnabled: true }))

    expect(await screen.findByText("Encrypted channels can't be shared.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create invite link" })).not.toBeInTheDocument()
  })

  it("should refresh to the shared state when a create races an accept", async () => {
    const list = vi
      .spyOn(streamConnectionsApi, "list")
      .mockResolvedValueOnce([])
      .mockResolvedValue([makeConnection({ state: "active", remoteWorkspaceName: "Beta" })])
    vi.spyOn(streamConnectionsApi, "createInvite").mockRejectedValue(
      new ApiError(409, "STREAM_ALREADY_SHARED", "already shared")
    )

    renderTab()
    await userEvent.click(await screen.findByRole("button", { name: "Create invite link" }))

    expect(await screen.findByText("Beta")).toBeInTheDocument()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })
})
