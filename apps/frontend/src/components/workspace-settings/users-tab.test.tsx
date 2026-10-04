import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import type { WorkspaceBootstrap, WorkspaceInvitation } from "@threahq/types"
import { render, screen, within } from "@/test"
import * as authModule from "@/auth"
import * as preferencesModule from "@/contexts/preferences-context"
import * as invitationsModule from "@/api/invitations"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as guestDmPolicyModule from "./guest-dm-policy-section"
import { PendingEmailInvitationDetails, UsersTab } from "./users-tab"

afterEach(() => vi.restoreAllMocks())

function workspaceUser(id: string, name: string, role: string) {
  return { id, workosUserId: `workos_${id}`, name, slug: name.toLowerCase(), role, setupCompleted: true }
}

function renderUsersTab(invitations: WorkspaceInvitation[]) {
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_admin" } as ReturnType<typeof authModule.useUser>)
  vi.spyOn(preferencesModule, "usePreferences").mockReturnValue({ preferences: null } as unknown as ReturnType<
    typeof preferencesModule.usePreferences
  >)
  vi.spyOn(guestDmPolicyModule, "GuestDmPolicySection").mockImplementation(() => <></>)
  vi.spyOn(workspacesModule, "useCachedWorkspaceBootstrap").mockReturnValue({
    viewerPermissions: ["members:write"],
  } as unknown as WorkspaceBootstrap)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
    workspaceUser("usr_admin", "Ada", "admin"),
    workspaceUser("usr_guest", "Gus", "guest"),
    workspaceUser("usr_member", "Mia", "member"),
  ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
  vi.spyOn(invitationsModule.invitationsApi, "list").mockResolvedValue(invitations)
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <UsersTab workspaceId="ws_1" />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function userRow(name: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find((item) => within(item).queryByText(name))
  if (!row) throw new Error(`No user row for ${name}`)
  return row
}

it("should show a guest's role as a Guest badge with no role picker when the viewer manages members", () => {
  renderUsersTab([])
  expect(within(userRow("Gus")).getByText("Guest")).toBeInTheDocument()
  expect(within(userRow("Gus")).queryByRole("combobox")).toBeNull()
  expect(within(userRow("Mia")).getByRole("combobox")).toHaveTextContent("Member")
})

it("should show Guest on a pending guest invitation when one is listed", async () => {
  renderUsersTab([
    {
      id: "inv_1",
      workspaceId: "ws_1",
      kind: "email",
      email: "guest@example.com",
      role: "guest",
      invitedBy: "usr_admin",
      status: "pending",
      note: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      acceptedAt: null,
      maxUses: null,
      useCount: 0,
    } as WorkspaceInvitation,
  ])
  const email = await screen.findByText("guest@example.com")
  expect(within(email.parentElement as HTMLElement).getByText("Guest")).toBeInTheDocument()
})

it("should retain role and local expiry for pending email invitations", () => {
  const formatDate = vi.fn(() => "Jan 8, 2027")
  render(
    <PendingEmailInvitationDetails
      email="invitee@example.com"
      role="admin"
      expiresAt="2027-01-08T10:00:00.000Z"
      formatDate={formatDate}
    />
  )

  expect(screen.getByText("invitee@example.com")).toBeInTheDocument()
  expect(screen.getByText("Admin")).toBeInTheDocument()
  expect(screen.getByText("Expires Jan 8, 2027")).toBeInTheDocument()
  expect(formatDate).toHaveBeenCalledWith(new Date("2027-01-08T10:00:00.000Z"))
})
