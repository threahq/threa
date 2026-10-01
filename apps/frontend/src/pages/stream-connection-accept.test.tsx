import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  StreamConnectionErrorCodes,
  type StreamConnection,
  type StreamConnectionLookupResponse,
  type Workspace,
} from "@threahq/types"
import { render, screen, userEvent, waitFor } from "@/test"
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

function makeLookup(overrides: Partial<StreamConnectionLookupResponse> = {}): StreamConnectionLookupResponse {
  return {
    connectionId: "sconn_1",
    state: "invited",
    hostWorkspaceId: "ws_acme",
    hostWorkspaceName: "Acme",
    hostRegion: "eu-north-1",
    streamDisplayName: null,
    streamSlug: "design",
    partnerWorkspaceId: null,
    partnerWorkspaceName: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  }
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/connections/tok_1"]}>
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

  it("should send a signed-out visitor to sign in and back to the same invite", async () => {
    mockSession(null, [])

    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(login).toHaveBeenCalledWith("/connections/tok_1")
  })

  it("should accept into the chosen workspace with the chosen visibility when the admin confirms", async () => {
    mockSession({ id: "user_1" }, [
      makeWorkspace("ws_acme", "Acme"),
      makeWorkspace("ws_beta", "Beta"),
      makeWorkspace("ws_gamma", "Gamma"),
    ])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())
    const accept = vi.spyOn(streamConnectionsApi, "accept").mockResolvedValue({ state: "active" } as StreamConnection)

    renderPage()

    expect(await screen.findByRole("heading", { name: "#design from Acme" })).toBeInTheDocument()
    expect(screen.getByText(/Hosted in Europe \(Stockholm\)/)).toBeInTheDocument()
    expect(screen.getByRole("combobox")).toHaveTextContent("Beta")
    await userEvent.click(screen.getByRole("button", { name: /Public/ }))
    await userEvent.click(screen.getByRole("button", { name: "Accept" }))

    expect(await screen.findByRole("heading", { name: "#design is shared with Beta" })).toBeInTheDocument()
    expect(accept).toHaveBeenCalledWith("ws_beta", { token: "tok_1", visibility: "public" })
    expect(screen.getByRole("link", { name: "Open Beta" })).toHaveAttribute("href", "/w/ws_beta")
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
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(
      makeLookup({ state: "active", partnerWorkspaceId: "ws_beta", partnerWorkspaceName: "Beta" })
    )

    renderPage()

    expect(await screen.findByRole("heading", { name: "#design is shared with Beta" })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("link", { name: "Open Beta" })).toHaveAttribute("href", "/w/ws_beta"))
  })

  it("should not name or link the accepting workspace to a viewer outside it", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_gamma", "Gamma")])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup({ state: "active" }))

    renderPage()

    expect(await screen.findByRole("heading", { name: "#design is shared with another workspace" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open Threa" })).toHaveAttribute("href", "/")
  })
})
