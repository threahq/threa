import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  StreamConnectionErrorCodes,
  type StreamConnection,
  type StreamConnectionLookupResponse,
  type Workspace,
} from "@threahq/types"
import { render, screen, userEvent, waitFor, within } from "@/test"
import { ApiError } from "@/api/client"
import { streamConnectionsApi } from "@/api/stream-connections"
import * as authModule from "@/auth"
import * as hooksModule from "@/hooks"
import { StreamConnectionAcceptPage } from "./stream-connection-accept"

const login = vi.fn()
const refetchWorkspaces = vi.fn()

function makeWorkspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    createdBy: "user_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function makeLookup(): StreamConnectionLookupResponse {
  return {
    state: "invited",
    hostWorkspaceId: "ws_acme",
    hostWorkspaceName: "Acme",
    hostRegion: "eu-north-1",
    streamDisplayName: null,
    streamSlug: "design",
    partnerWorkspaceId: null,
    partnerWorkspaceName: null,
  }
}

function makeAcceptedLookup(): StreamConnectionLookupResponse {
  return { ...makeLookup(), state: "active", partnerWorkspaceId: "ws_beta", partnerWorkspaceName: "Beta" }
}

function renderPage(path = "/connections/tok_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/connections/:token" element={<StreamConnectionAcceptPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return queryClient
}

function mockSession(user: { id: string } | null, workspaces: Workspace[] | undefined) {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    user,
    loading: false,
    error: null,
    login,
  } as unknown as ReturnType<typeof authModule.useAuth>)
  vi.spyOn(hooksModule, "useWorkspaces").mockReturnValue({
    workspaces,
    isLoading: false,
    refetch: refetchWorkspaces,
  } as unknown as ReturnType<typeof hooksModule.useWorkspaces>)
}

describe("StreamConnectionAcceptPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    login.mockReset()
    refetchWorkspaces.mockReset()
  })

  it.each(["/connections/tok_1", "/connections/a%7Cb%2Fc"])(
    "should send a signed-out visitor to sign in and back to the same invite (%s)",
    async (path) => {
      mockSession(null, [])

      renderPage(path)
      await userEvent.click(screen.getByRole("button", { name: "Sign in" }))

      expect(login).toHaveBeenCalledWith(path)
    }
  )

  it("should accept into the chosen workspace with the chosen visibility when the admin confirms", async () => {
    mockSession({ id: "user_1" }, [
      makeWorkspace("ws_acme", "Acme"),
      makeWorkspace("ws_beta", "Beta"),
      makeWorkspace("ws_gamma", "Gamma"),
    ])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())
    const accept = vi.spyOn(streamConnectionsApi, "accept").mockResolvedValue({ state: "active" } as StreamConnection)

    const queryClient = renderPage()

    expect(await screen.findByRole("heading", { name: "#design from Acme" })).toBeInTheDocument()
    expect(screen.getByText(/Hosted in Europe \(Stockholm\)/)).toBeInTheDocument()
    expect(screen.getByRole("combobox")).toHaveTextContent("Beta")
    const visibility = screen.getByRole("group", { name: "Visibility" })
    await userEvent.click(within(visibility).getByRole("button", { name: /Public/ }))
    expect(within(visibility).getByRole("button", { name: /Public/ })).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(screen.getByRole("button", { name: "Accept" }))

    expect(await screen.findByRole("heading", { name: "#design is shared with Beta" })).toBeInTheDocument()
    expect(accept).toHaveBeenCalledWith("ws_beta", { token: "tok_1", visibility: "public" })
    expect(screen.getByRole("link", { name: "Open Beta" })).toHaveAttribute("href", "/w/ws_beta")
    // Coming back to the link later shows where it went, not the form again.
    await waitFor(() =>
      expect(queryClient.getQueryData(["stream-connection-lookup", "tok_1"])).toMatchObject({
        state: "active",
        partnerWorkspaceId: "ws_beta",
      })
    )
  })

  it("should explain the refusal in place when the viewer isn't an admin of the chosen workspace", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())
    vi.spyOn(streamConnectionsApi, "accept").mockRejectedValue(new ApiError(403, "FORBIDDEN", "forbidden"))

    renderPage()
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Only admins of that workspace can accept.")
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: /Public/ }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it.each([
    { code: StreamConnectionErrorCodes.DISABLED, message: "Shared channels aren't turned on for that workspace." },
    { code: StreamConnectionErrorCodes.ALREADY_ACCEPTED, message: "Another workspace already accepted this invite." },
    { code: StreamConnectionErrorCodes.EXPIRED, message: "Invite expired" },
    { code: StreamConnectionErrorCodes.REVOKED, message: "Invite revoked" },
  ])("should say why accepting failed ($code)", async ({ code, message }) => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())
    vi.spyOn(streamConnectionsApi, "accept").mockRejectedValue(new ApiError(409, code, "refused"))

    renderPage()
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(message)
  })

  it("should stay on the shared screen when an invite refresh in flight lands after the accept", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    let finishRefresh: (lookup: StreamConnectionLookupResponse) => void = () => {}
    vi.spyOn(streamConnectionsApi, "lookup")
      .mockResolvedValueOnce(makeLookup())
      .mockImplementationOnce(() => new Promise((resolve) => (finishRefresh = resolve)))
    vi.spyOn(streamConnectionsApi, "accept").mockResolvedValue({ state: "active" } as StreamConnection)

    const queryClient = renderPage()
    await screen.findByRole("button", { name: "Accept" })
    void queryClient.refetchQueries()
    await userEvent.click(screen.getByRole("button", { name: "Accept" }))
    expect(await screen.findByRole("heading", { name: "#design is shared with Beta" })).toBeInTheDocument()
    finishRefresh(makeLookup())

    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    expect(screen.getByRole("heading", { name: "#design is shared with Beta" })).toBeInTheDocument()
  })

  it("should show the link as dead when it expired while the form was open", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup")
      .mockResolvedValueOnce(makeLookup())
      .mockRejectedValue(new ApiError(409, StreamConnectionErrorCodes.EXPIRED, "expired"))
    vi.spyOn(streamConnectionsApi, "accept").mockRejectedValue(
      new ApiError(409, StreamConnectionErrorCodes.EXPIRED, "expired")
    )

    renderPage()
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }))

    expect(await screen.findByRole("heading", { name: "Invite expired" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open Threa" })).toHaveAttribute("href", "/")
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument()
  })

  it("should point the viewer elsewhere when the host is their only workspace", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_acme", "Acme")])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())

    renderPage()

    expect(await screen.findByRole("heading", { name: "No other workspace to connect" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument()
  })

  it.each([
    { status: 404, code: StreamConnectionErrorCodes.NOT_FOUND, heading: "Invite not found" },
    { status: 409, code: StreamConnectionErrorCodes.REVOKED, heading: "Invite revoked" },
    { status: 409, code: StreamConnectionErrorCodes.EXPIRED, heading: "Invite expired" },
    { status: 409, code: StreamConnectionErrorCodes.ALREADY_ACCEPTED, heading: "Invite already used" },
    { status: 400, code: "VALIDATION_ERROR", heading: "Invite not found" },
  ])("should say why the link is dead and offer a way out ($code)", async ({ status, code, heading }) => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup").mockRejectedValue(new ApiError(status, code, "dead link"))

    renderPage()

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open Threa" })).toHaveAttribute("href", "/")
  })

  it("should load the invite again when the viewer retries a failed lookup", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup")
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL", "boom"))
      .mockResolvedValue(makeLookup())

    renderPage()
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }))

    expect(await screen.findByRole("heading", { name: "#design from Acme" })).toBeInTheDocument()
  })

  it("should keep the form when a background refresh of the invite fails", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    const lookup = vi
      .spyOn(streamConnectionsApi, "lookup")
      .mockResolvedValueOnce(makeLookup())
      .mockRejectedValue(new ApiError(500, "INTERNAL", "boom"))

    const queryClient = renderPage()
    expect(await screen.findByRole("heading", { name: "#design from Acme" })).toBeInTheDocument()
    await queryClient.refetchQueries()

    expect(lookup).toHaveBeenCalledTimes(2)
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled()
  })

  it("should offer a retry when the viewer's workspaces fail to load", async () => {
    mockSession({ id: "user_1" }, undefined)
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())

    renderPage()
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }))

    expect(screen.getByRole("heading", { name: "Couldn't load your workspaces" })).toBeInTheDocument()
    expect(refetchWorkspaces).toHaveBeenCalled()
  })

  it("should show where the channel went when the invite was already accepted", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeAcceptedLookup())

    renderPage()

    expect(await screen.findByRole("heading", { name: "#design is shared with Beta" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open Beta" })).toHaveAttribute("href", "/w/ws_beta")
  })

  it("should show a link that died after it loaded as dead, not as the stale invite", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup")
      .mockResolvedValueOnce(makeLookup())
      .mockRejectedValue(new ApiError(409, StreamConnectionErrorCodes.REVOKED, "revoked"))

    const queryClient = renderPage()
    expect(await screen.findByRole("heading", { name: "#design from Acme" })).toBeInTheDocument()
    await queryClient.refetchQueries()

    expect(await screen.findByRole("heading", { name: "Invite revoked" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument()
  })
})
