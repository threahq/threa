import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { StreamConnection, StreamConnectionLookupResponse, Workspace } from "@threahq/types"
import { render, screen, userEvent, waitFor } from "@/test"
import { ApiError } from "@/api/client"
import { streamConnectionsApi } from "@/api/stream-connections"
import * as authModule from "@/auth"
import * as hooksModule from "@/hooks"
import { StreamConnectionAcceptPage } from "./stream-connection-accept"

const login = vi.fn()

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
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/connections/tok_1"]}>
        <Routes>
          <Route path="/connections/:token" element={<StreamConnectionAcceptPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function mockSession(user: { id: string } | null, workspaces: Workspace[]) {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    user,
    loading: false,
    error: null,
    login,
  } as unknown as ReturnType<typeof authModule.useAuth>)
  vi.spyOn(hooksModule, "useWorkspaces").mockReturnValue({
    workspaces,
    isLoading: false,
  } as unknown as ReturnType<typeof hooksModule.useWorkspaces>)
}

describe("StreamConnectionAcceptPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    login.mockReset()
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
  })

  it("should point the viewer elsewhere when the host is their only workspace", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_acme", "Acme")])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())

    renderPage()

    expect(await screen.findByRole("heading", { name: "No other workspace to connect" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument()
  })

  it("should say the invite expired when the lookup reports it", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup").mockRejectedValue(
      new ApiError(410, "STREAM_CONNECTION_EXPIRED", "expired")
    )

    renderPage()

    expect(await screen.findByRole("heading", { name: "Invite expired" })).toBeInTheDocument()
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
})
