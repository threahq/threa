import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { WorkspaceSelectPage } from "./workspace-select"
import type { Workspace } from "@threahq/types"
import { ApiError } from "@/api/client"
import * as authModule from "@/auth"
import * as hooksModule from "@/hooks"

const mockUseAuth = vi.fn()
const mockUseWorkspaces = vi.fn()
const mockUseCreateWorkspace = vi.fn()
const mockUseAcceptInvitation = vi.fn()

function WorkspaceRouteProbe() {
  const { workspaceId } = useParams()
  return <div data-testid="workspace-route">{workspaceId}</div>
}

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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/workspaces"]}>
      <Routes>
        <Route path="/workspaces" element={<WorkspaceSelectPage />} />
        <Route path="/w/:workspaceId" element={<WorkspaceRouteProbe />} />
        <Route path="/w/:workspaceId/setup" element={<div data-testid="setup-route">setup</div>} />
        <Route path="/login" element={<div data-testid="login-route">login</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe("WorkspaceSelectPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(authModule, "useAuth").mockImplementation(() => mockUseAuth() as ReturnType<typeof authModule.useAuth>)
    vi.spyOn(hooksModule, "useWorkspaces").mockImplementation(
      () => mockUseWorkspaces() as ReturnType<typeof hooksModule.useWorkspaces>
    )
    vi.spyOn(hooksModule, "useCreateWorkspace").mockImplementation(
      () => mockUseCreateWorkspace() as ReturnType<typeof hooksModule.useCreateWorkspace>
    )
    vi.spyOn(hooksModule, "useAcceptInvitation").mockImplementation(
      () => mockUseAcceptInvitation() as ReturnType<typeof hooksModule.useAcceptInvitation>
    )
    vi.spyOn(hooksModule, "useRegions").mockReturnValue({
      data: undefined,
      isLoading: false,
    } as ReturnType<typeof hooksModule.useRegions>)

    mockUseAuth.mockReset()
    mockUseWorkspaces.mockReset()
    mockUseCreateWorkspace.mockReset()
    mockUseAcceptInvitation.mockReset()

    mockUseAuth.mockReturnValue({
      user: {
        id: "user_1",
        email: "kris@example.com",
        name: "Kris",
        workosUserId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      loading: false,
      error: null,
    })

    mockUseCreateWorkspace.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
    })

    mockUseAcceptInvitation.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    })
  })

  it("should redirect to the only workspace when user has one workspace", async () => {
    mockUseWorkspaces.mockReturnValue({
      workspaces: [makeWorkspace("workspace_1", "Solo")],
      pendingInvitations: [],
      isLoading: false,
      error: null,
    })

    renderPage()

    expect(await screen.findByTestId("workspace-route")).toHaveTextContent("workspace_1")
  })

  it("should not auto-redirect when there are pending invitations", () => {
    mockUseWorkspaces.mockReturnValue({
      workspaces: [makeWorkspace("workspace_1", "Solo")],
      pendingInvitations: [
        { id: "inv_1", workspaceId: "ws_2", workspaceName: "Invited WS", expiresAt: "2026-12-01T00:00:00.000Z" },
      ],
      isLoading: false,
      error: null,
    })

    renderPage()

    expect(screen.getByText("Select a workspace to continue")).toBeInTheDocument()
    expect(screen.getByText("Invited WS")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument()
  })

  it("should keep the setup navigation when accepting an invitation updates the workspace list immediately", async () => {
    let accepted = false

    mockUseWorkspaces.mockImplementation(() => ({
      workspaces: [makeWorkspace("workspace_1", "Solo")],
      pendingInvitations: accepted
        ? []
        : [{ id: "inv_1", workspaceId: "workspace_1", workspaceName: "Solo", expiresAt: "2026-12-01T00:00:00.000Z" }],
      isLoading: false,
      error: null,
    }))

    mockUseAcceptInvitation.mockReturnValue({
      mutate: (_invitationId: string, options?: { onSuccess?: (result: { workspaceId: string }) => void }) => {
        accepted = true
        options?.onSuccess?.({ workspaceId: "workspace_1" })
      },
      isPending: false,
    })

    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Accept" }))

    expect(await screen.findByTestId("setup-route")).toBeInTheDocument()
  })

  it("should show a structured invitation acceptance error", async () => {
    mockUseWorkspaces.mockReturnValue({
      workspaces: [],
      cachedWorkspaces: [],
      pendingInvitations: [
        { id: "inv_1", workspaceId: "workspace_1", workspaceName: "Full workspace", expiresAt: null },
      ],
      isLoading: false,
      error: null,
    })
    mockUseAcceptInvitation.mockReturnValue({
      mutate: (_invitationId: string, options?: { onError?: (error: unknown) => void }) => {
        options?.onError?.(new ApiError(409, "INVITATION_EXHAUSTED", "Invitation exhausted"))
      },
      isPending: false,
    })

    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Accept" }))

    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled()
    expect(screen.getByText("This invite link has reached its join limit.")).toBeInTheDocument()
  })

  it("should show workspace picker when user has multiple workspaces", () => {
    mockUseWorkspaces.mockReturnValue({
      workspaces: [makeWorkspace("workspace_1", "Alpha"), makeWorkspace("workspace_2", "Beta")],
      pendingInvitations: [],
      isLoading: false,
      error: null,
    })

    renderPage()

    expect(screen.getByText("Select a workspace to continue")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "/w/workspace_1")
    expect(screen.getByRole("link", { name: "Beta" })).toHaveAttribute("href", "/w/workspace_2")
  })

  it("renders the IDB-cached workspaces instead of a spinner while the list query is still loading", () => {
    mockUseWorkspaces.mockReturnValue({
      workspaces: undefined,
      cachedWorkspaces: [makeWorkspace("workspace_1", "Alpha"), makeWorkspace("workspace_2", "Beta")],
      pendingInvitations: [],
      isLoading: true,
      error: null,
    })

    renderPage()

    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "/w/workspace_1")
    expect(screen.getByRole("link", { name: "Beta" })).toHaveAttribute("href", "/w/workspace_2")
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument()
  })

  it("does not auto-redirect off a single cached workspace until the list is authoritative", async () => {
    // A pending invitation isn't known until the network list resolves; the
    // cached single workspace renders as a selectable entry meanwhile so the
    // redirect can't skip an invite the user hasn't been shown yet.
    mockUseWorkspaces.mockReturnValue({
      workspaces: undefined,
      cachedWorkspaces: [makeWorkspace("workspace_solo", "Solo")],
      pendingInvitations: [],
      isLoading: true,
      error: null,
    })

    renderPage()

    expect(await screen.findByRole("link", { name: "Solo" })).toHaveAttribute("href", "/w/workspace_solo")
    expect(screen.queryByTestId("workspace-route")).not.toBeInTheDocument()
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument()
  })

  it("keeps showing the cached list when revalidation errors instead of blanking to the error screen", () => {
    mockUseWorkspaces.mockReturnValue({
      workspaces: undefined,
      cachedWorkspaces: [makeWorkspace("workspace_1", "Alpha"), makeWorkspace("workspace_2", "Beta")],
      pendingInvitations: [],
      isLoading: false,
      error: new Error("network down"),
    })

    renderPage()

    expect(screen.getByRole("link", { name: "Alpha" })).toBeInTheDocument()
    expect(screen.queryByText("Failed to load workspaces")).not.toBeInTheDocument()
  })

  it("should show invite-only message when invite is required", () => {
    mockUseWorkspaces.mockReturnValue({
      workspaces: [],
      pendingInvitations: [],
      isLoading: false,
      error: null,
    })
    mockUseCreateWorkspace.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      error: new ApiError(
        403,
        "WORKSPACE_CREATION_INVITE_REQUIRED",
        "Workspace creation requires a dedicated workspace invite."
      ),
    })

    renderPage()

    expect(screen.getByText("Workspace creation requires a dedicated workspace invite.")).toBeInTheDocument()
  })

  it("should show backend message for non-invite 403 errors", () => {
    mockUseWorkspaces.mockReturnValue({
      workspaces: [],
      pendingInvitations: [],
      isLoading: false,
      error: null,
    })
    mockUseCreateWorkspace.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      error: new ApiError(403, "UNKNOWN_ERROR", "Workspace quota exceeded"),
    })

    renderPage()

    expect(screen.getByText("Workspace quota exceeded")).toBeInTheDocument()
    expect(screen.queryByText("Workspace creation requires a dedicated workspace invite.")).not.toBeInTheDocument()
  })
})
