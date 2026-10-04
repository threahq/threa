import { useState } from "react"
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
import { ApiError, api } from "@/api/client"
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
    tier: "full",
    createdBy: "user_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

type PendingLookup = Extract<StreamConnectionLookupResponse, { state: "invited" }>

function makeLookup(overrides: Partial<PendingLookup> = {}): PendingLookup {
  return {
    state: "invited",
    hostWorkspaceId: "ws_acme",
    hostWorkspaceName: "Acme",
    hostRegion: "eu-north-1",
    streamDisplayName: null,
    streamSlug: "design",
    partnerWorkspaceId: null,
    partnerWorkspaceName: null,
    partners: [],
    ...overrides,
  }
}

function makePartners(...names: string[]): PendingLookup["partners"] {
  return names.map((name) => ({ workspaceId: `ws_${name.toLowerCase()}`, workspaceName: name }))
}

function makeAcceptedLookup(): StreamConnectionLookupResponse {
  return {
    state: "active",
    hostWorkspaceId: "ws_acme",
    hostWorkspaceName: "Acme",
    hostRegion: "eu-north-1",
    streamDisplayName: null,
    streamSlug: "design",
    partnerWorkspaceId: "ws_beta",
    partnerWorkspaceName: "Beta",
  }
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
    vi.spyOn(api, "get").mockResolvedValue(undefined)
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
    { code: StreamConnectionErrorCodes.ALREADY_CONNECTED, message: "That workspace is already in this channel." },
    { code: StreamConnectionErrorCodes.EXPIRED, message: "Invite expired" },
    { code: StreamConnectionErrorCodes.REVOKED, message: "Invite revoked" },
    {
      code: StreamConnectionErrorCodes.NOT_SHAREABLE,
      message: "The host stopped sharing this channel. Ask the channel's admin about it.",
    },
    {
      code: StreamConnectionErrorCodes.HOST_REGION_UNAVAILABLE,
      message: "Couldn't reach the channel's workspace. Try again in a moment.",
    },
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

  it("should offer only the workspaces the viewer can accept into", async () => {
    mockSession({ id: "user_1" }, [
      makeWorkspace("ws_acme", "Acme"),
      makeWorkspace("ws_beta", "Beta"),
      makeWorkspace("ws_gamma", "Gamma"),
      makeWorkspace("ws_delta", "Delta"),
      makeWorkspace("ws_epsilon", "Epsilon"),
    ])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())
    const refusals: Record<string, ApiError> = {
      ws_beta: new ApiError(403, "FORBIDDEN", "not an admin"),
      ws_gamma: new ApiError(404, StreamConnectionErrorCodes.DISABLED, "sharing off"),
      ws_epsilon: new ApiError(500, "INTERNAL", "boom"),
    }
    let answerProbes = () => {}
    const probesAnswered = new Promise<void>((resolve) => (answerProbes = resolve))
    const get = vi.spyOn(api, "get").mockImplementation(async (path) => {
      await probesAnswered
      const refusal = refusals[path.split("/")[3]]
      if (refusal) throw refusal
      return undefined as never
    })

    renderPage()
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4))
    const comboboxWhilePending = screen.queryByRole("combobox")
    answerProbes()
    await userEvent.click(await screen.findByRole("combobox"))

    const options = await screen.findAllByRole("option")
    expect({
      comboboxWhilePending,
      offered: options.map((option) => option.textContent),
      probed: get.mock.calls.map(([path]) => path.split("/")[3]),
    }).toEqual({
      comboboxWhilePending: null,
      offered: ["Delta", "Epsilon"],
      probed: ["ws_beta", "ws_gamma", "ws_delta", "ws_epsilon"],
    })
  })

  it("should point the viewer elsewhere when no other workspace can accept", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_acme", "Acme"), makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())
    vi.spyOn(api, "get").mockRejectedValue(new ApiError(403, "FORBIDDEN", "not an admin"))

    renderPage()

    expect(await screen.findByRole("heading", { name: "No other workspace to connect" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument()
  })

  it("should leave the host and every partner out of the picker", async () => {
    mockSession({ id: "user_1" }, [
      makeWorkspace("ws_acme", "Acme"),
      makeWorkspace("ws_beta", "Beta"),
      makeWorkspace("ws_gamma", "Gamma"),
      makeWorkspace("ws_delta", "Delta"),
      makeWorkspace("ws_epsilon", "Epsilon"),
    ])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup({ partners: makePartners("Beta", "Gamma") }))
    const get = vi.spyOn(api, "get")

    renderPage()
    await userEvent.click(await screen.findByRole("combobox"))

    const options = await screen.findAllByRole("option")
    expect({
      offered: options.map((option) => option.textContent),
      probed: get.mock.calls.map(([path]) => path.split("/")[3]),
    }).toEqual({
      offered: ["Delta", "Epsilon"],
      probed: ["ws_delta", "ws_epsilon"],
    })
  })

  it.each([
    { partners: [], line: null },
    { partners: ["Beta"], line: "Beta is already in this channel." },
    { partners: ["Beta", "Gamma"], line: "Beta and Gamma are already in this channel." },
    { partners: ["Beta", "Gamma", "Delta"], line: "Beta, Gamma, and Delta are already in this channel." },
  ])("should say who is already in the channel when it has $partners.length partners", async ({ partners, line }) => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_zeta", "Zeta")])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup({ partners: makePartners(...partners) }))

    renderPage()
    await screen.findByRole("heading", { name: "#design from Acme" })

    expect(screen.queryByText(/already in this channel/)?.textContent ?? null).toBe(line)
  })

  it("should point the viewer elsewhere when every workspace they have is already in the channel", async () => {
    mockSession({ id: "user_1" }, [
      makeWorkspace("ws_acme", "Acme"),
      makeWorkspace("ws_beta", "Beta"),
      makeWorkspace("ws_gamma", "Gamma"),
    ])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup({ partners: makePartners("Beta", "Gamma") }))
    const get = vi.spyOn(api, "get")

    renderPage()

    expect(await screen.findByRole("heading", { name: "No other workspace to connect" })).toBeInTheDocument()
    expect({ accept: screen.queryByRole("button", { name: "Accept" }), probes: get.mock.calls }).toEqual({
      accept: null,
      probes: [],
    })
  })

  it("should drop the accept error when the refreshed invite shows the failed workspace is already in the channel", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta"), makeWorkspace("ws_gamma", "Gamma")])
    vi.spyOn(streamConnectionsApi, "lookup")
      .mockResolvedValueOnce(makeLookup())
      .mockResolvedValue(makeLookup({ partners: makePartners("Beta") }))
    vi.spyOn(streamConnectionsApi, "accept").mockRejectedValue(
      new ApiError(409, StreamConnectionErrorCodes.ALREADY_CONNECTED, "already connected")
    )

    renderPage()
    expect(await screen.findByRole("combobox")).toHaveTextContent("Beta")
    await userEvent.click(screen.getByRole("button", { name: "Accept" }))

    expect(await screen.findByText("Beta is already in this channel.")).toBeInTheDocument()
    expect({
      selected: screen.getByRole("combobox").textContent,
      alert: screen.queryByRole("alert"),
      acceptEnabled: !screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled"),
    }).toEqual({
      selected: "Choose a workspace",
      alert: null,
      acceptEnabled: false,
    })
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
    { status: 409, code: StreamConnectionErrorCodes.NOT_SHAREABLE, heading: "Channel no longer shared" },
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

  it("should show the form once a retry loads the viewer's workspaces", async () => {
    mockSession({ id: "user_1" }, undefined)
    vi.spyOn(hooksModule, "useWorkspaces").mockImplementation(function useRetryableWorkspaces() {
      const [workspaces, setWorkspaces] = useState<Workspace[] | undefined>(undefined)
      return {
        workspaces,
        isLoading: false,
        refetch: () => setWorkspaces([makeWorkspace("ws_beta", "Beta")]),
      } as unknown as ReturnType<typeof hooksModule.useWorkspaces>
    })
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())

    renderPage()
    expect(await screen.findByRole("heading", { name: "Couldn't load your workspaces" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))

    expect(await screen.findByRole("combobox")).toHaveTextContent("Beta")
  })

  it("should keep one page shell from loading to the form so the entrance doesn't replay", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    let finishLookup: (lookup: StreamConnectionLookupResponse) => void = () => {}
    vi.spyOn(streamConnectionsApi, "lookup").mockImplementation(
      () => new Promise((resolve) => (finishLookup = resolve))
    )

    renderPage()
    expect(await screen.findByText("Loading invite…")).toBeInTheDocument()
    const logoWhileLoading = screen.getByRole("img", { name: "Threa logo" })
    finishLookup(makeLookup())

    expect(await screen.findByRole("button", { name: "Accept" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Threa logo" })).toBe(logoWhileLoading)
  })

  it("should send a viewer with no workspace to create one", async () => {
    mockSession({ id: "user_1" }, [])
    vi.spyOn(streamConnectionsApi, "lookup").mockResolvedValue(makeLookup())

    renderPage()

    expect(await screen.findByRole("heading", { name: "You don't have a workspace yet" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Create a workspace" })).toHaveAttribute("href", "/workspaces")
  })

  it("should say the host is unreachable and recover on retry when the invite can't be loaded", async () => {
    mockSession({ id: "user_1" }, [makeWorkspace("ws_beta", "Beta")])
    vi.spyOn(streamConnectionsApi, "lookup")
      .mockRejectedValueOnce(new ApiError(503, StreamConnectionErrorCodes.HOST_REGION_UNAVAILABLE, "unreachable"))
      .mockResolvedValue(makeLookup())

    renderPage()
    expect(
      await screen.findByText("Couldn't reach the channel's workspace. Try again in a moment.")
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))

    expect(await screen.findByRole("heading", { name: "#design from Acme" })).toBeInTheDocument()
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
