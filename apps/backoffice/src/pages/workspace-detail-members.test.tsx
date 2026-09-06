import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { WorkspaceDetailMembersPage } from "./workspace-detail-members"
import { backofficeKeys, type WorkspaceDetail, type WorkspaceInvitation, type WorkspaceMember } from "@/api/backoffice"

function renderAt(path: string, opts: { workspace?: WorkspaceDetail } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (opts.workspace) {
    queryClient.setQueryData(backofficeKeys.workspace(opts.workspace.id), opts.workspace)
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/workspaces/:id/members" element={<WorkspaceDetailMembersPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function makeWorkspace(overrides: Partial<WorkspaceDetail> = {}): WorkspaceDetail {
  return {
    id: "ws_abc",
    name: "Acme",
    slug: "acme",
    region: "local",
    createdByWorkosUserId: "user_01",
    workosOrganizationId: "org_01",
    memberCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    owner: { workosUserId: "user_01", email: null, name: null },
    ...overrides,
  }
}

type RouteOverrides = {
  members?: { status?: number; body?: { members?: WorkspaceMember[]; error?: string; code?: string } }
  invitations?: { status?: number; body?: { invitations?: WorkspaceInvitation[]; error?: string; code?: string } }
}

/**
 * Backoffice members tab fires two queries in parallel (members + invitations).
 * Route by URL so tests don't depend on fetch order.
 */
function installBackofficeFetch(routes: RouteOverrides): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/invitations")) {
      const { status = 200, body = { invitations: [] } } = routes.invitations ?? {}
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url.includes("/members")) {
      const { status = 200, body = { members: [] } } = routes.members ?? {}
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("WorkspaceDetailMembersPage", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function daysFromNow(days: number): string {
    // Half-day padding so floor() doesn't drift to N-1 due to ms between
    // `Date.now()` here and `Date.now()` inside the formatter.
    return new Date(Date.now() + (days + 0.5) * 86_400_000).toISOString()
  }

  it("renders the members empty state when there are no members", async () => {
    const fetchMock = installBackofficeFetch({})
    renderAt("/workspaces/ws_abc/members")

    await screen.findByText(/No members yet/)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/backoffice/workspaces/ws_abc/members"),
      expect.objectContaining({ method: "GET" })
    )
  })

  it("renders one row per member with role chips, status, and email", async () => {
    installBackofficeFetch({
      members: {
        body: {
          members: [
            {
              workosUserId: "user_01",
              email: "alice@example.com",
              firstName: "Alice",
              lastName: "Anderson",
              status: "active",
              roleSlugs: ["owner", "admin"],
              lastEventAt: new Date().toISOString(),
            },
            {
              workosUserId: "user_02",
              email: null,
              firstName: null,
              lastName: null,
              status: "pending",
              roleSlugs: [],
              lastEventAt: new Date().toISOString(),
            },
          ],
        },
      },
    })

    renderAt("/workspaces/ws_abc/members")

    await waitFor(() => {
      expect(screen.getByText("Alice Anderson")).toBeInTheDocument()
    })
    expect(screen.getByText("alice@example.com")).toBeInTheDocument()
    expect(screen.getByText("owner")).toBeInTheDocument()
    expect(screen.getByText("admin")).toBeInTheDocument()
    expect(screen.getByText("active")).toBeInTheDocument()
    // Member with no name or email falls back to the workos user id
    expect(screen.getByText("user_02")).toBeInTheDocument()
    expect(screen.getByText("pending")).toBeInTheDocument()
  })

  it("shows the not-linked empty state when the workspace has no WorkOS organization", async () => {
    installBackofficeFetch({})

    renderAt("/workspaces/ws_abc/members", {
      workspace: makeWorkspace({ workosOrganizationId: null }),
    })

    await screen.findByText(/isn't linked to a WorkOS organization/)
  })

  it("shows an error state when the members request fails", async () => {
    installBackofficeFetch({
      members: { status: 500, body: { error: "boom", code: "INTERNAL" } },
    })

    renderAt("/workspaces/ws_abc/members")

    await screen.findByText(/Couldn't load members/)
  })

  it("renders pending invitations with kind, role, inviter, and expiry", async () => {
    installBackofficeFetch({
      invitations: {
        body: {
          invitations: [
            {
              id: "inv_email_admin",
              kind: "email",
              email: "bob@example.com",
              roleSlug: "admin",
              expiresAt: daysFromNow(3),
              createdAt: new Date().toISOString(),
              inviter: { workosUserId: "user_01", email: "alice@example.com", name: "Alice Anderson" },
            },
            {
              id: "inv_link_member",
              kind: "link",
              email: null,
              roleSlug: "member",
              expiresAt: null,
              createdAt: new Date().toISOString(),
              inviter: null,
            },
          ],
        },
      },
    })

    renderAt("/workspaces/ws_abc/members")

    await waitFor(() => {
      expect(screen.getByText("bob@example.com")).toBeInTheDocument()
    })
    expect(screen.getByText("Unclaimed link")).toBeInTheDocument()
    expect(screen.getByText("email")).toBeInTheDocument()
    expect(screen.getByText("link")).toBeInTheDocument()
    expect(screen.getByText("admin")).toBeInTheDocument()
    expect(screen.getByText("member")).toBeInTheDocument()
    expect(screen.getByText(/Invited by Alice Anderson/)).toBeInTheDocument()
    // 3 days out from the fake-now clock
    expect(screen.getByText("Expires in 3d")).toBeInTheDocument()
    expect(screen.getByText("Never expires")).toBeInTheDocument()
  })

  it("shows the pending-invitations empty state when there are none", async () => {
    installBackofficeFetch({})
    renderAt("/workspaces/ws_abc/members")
    await screen.findByText("No pending invitations.")
  })

  it("renders 'Invited by Unknown' when the inviter lookup misses", async () => {
    installBackofficeFetch({
      invitations: {
        body: {
          invitations: [
            {
              id: "inv_unknown_inviter",
              kind: "email",
              email: "anon@example.com",
              roleSlug: "member",
              expiresAt: daysFromNow(2),
              createdAt: new Date().toISOString(),
              inviter: { workosUserId: "user_missing", email: null, name: null },
            },
          ],
        },
      },
    })

    renderAt("/workspaces/ws_abc/members")

    await screen.findByText(/Invited by Unknown/)
  })
})
