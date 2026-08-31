import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, userEvent, waitFor } from "@/test"
import type { Workspace } from "@threa/types"
import { ConnectPage, CONNECTED_BOT_SCOPES, normalizeCode, slugForBot } from "./connect"
import * as authModule from "@/auth"
import * as hooksModule from "@/hooks"
import { botConnectApi } from "@/api/bot-connect"
import { botsApi } from "@/api/bots"
import { ApiError } from "@/api/client"

const mockUseAuth = vi.fn()
const mockUseWorkspaces = vi.fn()

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

function renderPage(path = "/connect?code=BCDF-GHJK") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/connect" element={<ConnectPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const signedIn = {
  user: { id: "user_1", email: "kris@example.com", name: "Kris" },
  loading: false,
  error: null,
  login: vi.fn(),
}

describe("ConnectPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(authModule, "useAuth").mockImplementation(() => mockUseAuth() as ReturnType<typeof authModule.useAuth>)
    vi.spyOn(hooksModule, "useWorkspaces").mockImplementation(
      () => mockUseWorkspaces() as ReturnType<typeof hooksModule.useWorkspaces>
    )
    mockUseAuth.mockReset()
    mockUseWorkspaces.mockReset()
    mockUseAuth.mockReturnValue(signedIn)
    mockUseWorkspaces.mockReturnValue({
      workspaces: [makeWorkspace("ws_1", "Acme"), makeWorkspace("ws_2", "Side")],
      isLoading: false,
    })
  })

  it("normalizes typed codes and derives bot slugs", () => {
    expect(normalizeCode("bcdf ghjk")).toBe("BCDF-GHJK")
    expect(normalizeCode("bc")).toBe("BC")
    expect(slugForBot("My Agent (v2)!")).toBe("my-agent-v2")
  })

  it("sends a signed-out visitor to sign in and comes back to the same code", async () => {
    mockUseAuth.mockReturnValue({ ...signedIn, user: null })
    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(signedIn.login).toHaveBeenCalledWith("/connect?code=BCDF-GHJK")
  })

  it("creates the bot and key in the chosen workspace and hands the key to the waiting device", async () => {
    vi.spyOn(botConnectApi, "lookup").mockResolvedValue({
      userCode: "BCDF-GHJK",
      requestedName: "my-agent",
      requestedHost: "laptop",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    const create = vi
      .spyOn(botsApi, "create")
      .mockRejectedValueOnce(new ApiError(409, "DUPLICATE_SLUG", "taken"))
      .mockResolvedValueOnce({ id: "bot_1", slug: "my-agent-x1y2", name: "my-agent" } as never)
    const createKey = vi
      .spyOn(botsApi, "createKey")
      .mockResolvedValue({ key: { id: "key_1" } as never, value: "threa_bk_minted" })
    const approve = vi.spyOn(botConnectApi, "approve").mockResolvedValue()

    renderPage()
    expect(await screen.findByRole("heading", { name: /Connect my-agent from laptop/ })).toBeInTheDocument()
    expect(screen.getByLabelText("Bot name")).toHaveValue("my-agent")
    await userEvent.click(screen.getByRole("button", { name: "Connect" }))

    await waitFor(() => expect(approve).toHaveBeenCalled())
    expect(create).toHaveBeenNthCalledWith(1, "ws_1", {
      type: "personal",
      name: "my-agent",
      slug: "my-agent",
      traits: ["mentionable", "active-scratchpad"],
    })
    expect(create.mock.calls[1]![1].slug).toMatch(/^my-agent-[a-z0-9]{4}$/)
    expect(createKey).toHaveBeenCalledWith("ws_1", "bot_1", { name: "threa-bot connect", scopes: CONNECTED_BOT_SCOPES })
    expect(approve).toHaveBeenCalledWith({
      code: "BCDF-GHJK",
      workspaceId: "ws_1",
      workspaceName: "Acme",
      botId: "bot_1",
      botSlug: "my-agent-x1y2",
      scope: CONNECTED_BOT_SCOPES.join(" "),
      apiKey: "threa_bk_minted",
    })
    expect(await screen.findByRole("heading", { name: /@my-agent-x1y2 is connected to Acme/ })).toBeInTheDocument()
  })

  it("keeps the minted bot and key across a transient approval failure, and cleans up when the code is gone", async () => {
    vi.spyOn(botConnectApi, "lookup").mockResolvedValue({
      userCode: "BCDF-GHJK",
      requestedName: "my-agent",
      requestedHost: null,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    const create = vi
      .spyOn(botsApi, "create")
      .mockResolvedValue({ id: "bot_1", slug: "my-agent", name: "my-agent" } as never)
    const createKey = vi
      .spyOn(botsApi, "createKey")
      .mockResolvedValue({ key: { id: "key_1" } as never, value: "threa_bk_minted" })
    const update = vi.spyOn(botsApi, "update").mockResolvedValue({} as never)
    const approve = vi
      .spyOn(botConnectApi, "approve")
      .mockRejectedValueOnce(new ApiError(502, "BAD_GATEWAY", "upstream hiccup"))
      .mockRejectedValue(new ApiError(409, "BOT_CONNECT_NOT_PENDING", "gone"))
    const archive = vi
      .spyOn(botsApi, "archive")
      .mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "region down"))
      .mockResolvedValueOnce({} as never)

    renderPage()
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }))
    expect(await screen.findByText("upstream hiccup")).toBeInTheDocument()
    expect(archive).not.toHaveBeenCalled()

    // The code is gone and the cleanup fails: the identifiers are kept, the user is told.
    await userEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByText(/removing the bot @my-agent failed/)).toBeInTheDocument()
    expect(archive).toHaveBeenCalledTimes(1)

    // Another try archives without minting anything again.
    await userEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByText(/no longer valid \(expired/)).toBeInTheDocument()
    expect(create).toHaveBeenCalledTimes(1)
    expect(createKey).toHaveBeenCalledTimes(1)
    expect(approve).toHaveBeenCalledTimes(3)
    expect(archive).toHaveBeenCalledTimes(2)
    expect(archive).toHaveBeenLastCalledWith("ws_1", "bot_1")
    // An unchanged checkbox adds no extra write to the retry path.
    expect(update).not.toHaveBeenCalled()
  })

  it("re-asserts a checkbox changed between retries onto the reused bot", async () => {
    vi.spyOn(botConnectApi, "lookup").mockResolvedValue({
      userCode: "BCDF-GHJK",
      requestedName: "my-agent",
      requestedHost: null,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    vi.spyOn(botsApi, "create").mockResolvedValue({ id: "bot_1", slug: "my-agent", name: "my-agent" } as never)
    vi.spyOn(botsApi, "createKey").mockResolvedValue({ key: { id: "key_1" } as never, value: "threa_bk_minted" })
    const update = vi.spyOn(botsApi, "update").mockResolvedValue({} as never)
    vi.spyOn(botConnectApi, "approve")
      .mockRejectedValueOnce(new ApiError(502, "BAD_GATEWAY", "upstream hiccup"))
      .mockResolvedValue()

    renderPage()
    await userEvent.click(await screen.findByLabelText("Let it read everything you can read"))
    await userEvent.click(screen.getByRole("button", { name: "Connect" }))
    await screen.findByText("upstream hiccup")
    expect(update).not.toHaveBeenCalled()

    await userEvent.click(screen.getByLabelText("Let it read everything you can read"))
    await userEvent.click(screen.getByRole("button", { name: "Connect" }))
    await screen.findByRole("heading", { name: /is connected to Acme/ })
    expect(update).toHaveBeenCalledWith("ws_1", "bot_1", { readsAsOwner: false })
  })

  it("mints the bot with reads-as-owner when the checkbox is ticked", async () => {
    vi.spyOn(botConnectApi, "lookup").mockResolvedValue({
      userCode: "BCDF-GHJK",
      requestedName: "my-agent",
      requestedHost: null,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    const create = vi
      .spyOn(botsApi, "create")
      .mockResolvedValue({ id: "bot_1", slug: "my-agent", name: "my-agent" } as never)
    vi.spyOn(botsApi, "createKey").mockResolvedValue({ key: { id: "key_1" } as never, value: "threa_bk_minted" })
    vi.spyOn(botConnectApi, "approve").mockResolvedValue()

    renderPage()
    await userEvent.click(await screen.findByLabelText("Let it read everything you can read"))
    await userEvent.click(screen.getByRole("button", { name: "Connect" }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("ws_1", {
        type: "personal",
        name: "my-agent",
        slug: "my-agent",
        traits: ["mentionable", "active-scratchpad"],
        readsAsOwner: true,
      })
    )
  })

  it("does not fetch workspaces before sign-in", () => {
    mockUseAuth.mockReturnValue({ ...signedIn, user: null })
    renderPage()
    expect(mockUseWorkspaces).not.toHaveBeenCalled()
  })

  it("denies without creating anything", async () => {
    vi.spyOn(botConnectApi, "lookup").mockResolvedValue({
      userCode: "BCDF-GHJK",
      requestedName: null,
      requestedHost: null,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    const create = vi.spyOn(botsApi, "create")
    const deny = vi.spyOn(botConnectApi, "deny").mockResolvedValue()
    renderPage()
    await userEvent.click(await screen.findByRole("button", { name: "Not me, deny" }))
    await waitFor(() => expect(deny).toHaveBeenCalledWith("BCDF-GHJK"))
    expect(create).not.toHaveBeenCalled()
    expect(await screen.findByRole("heading", { name: "Request denied" })).toBeInTheDocument()
  })

  it("explains an unknown or expired code and lets the user retype it", async () => {
    vi.spyOn(botConnectApi, "lookup").mockRejectedValue(new ApiError(404, "BOT_CONNECT_NOT_FOUND", "nope"))
    renderPage()
    expect(await screen.findByRole("heading", { name: /No pending request for BCDF-GHJK/ })).toBeInTheDocument()
    expect(screen.getByLabelText("Code from your terminal")).toBeInTheDocument()
  })
})
