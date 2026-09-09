import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import { render, screen, userEvent, waitFor } from "@/test"
import { AccountSwitcherDialog } from "./account-switcher-dialog"
import { accountsApi, type AccountSummary } from "@/api"
import * as authModule from "@/auth"
import { resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the picker's real workspace-roster read path
import { db, type CachedWorkspaceUser } from "@/db"

const mockLogin = vi.fn()
const mockSwitchAccount = vi.fn(async () => {})

function mockAccounts(accounts: AccountSummary[], maxAccounts = 4) {
  vi.spyOn(accountsApi, "list").mockResolvedValue({ accounts, maxAccounts })
}

const WORKSPACE_ID = "workspace_1"

function workspaceUser(overrides: Partial<CachedWorkspaceUser> & { id: string }): CachedWorkspaceUser {
  return {
    workspaceId: WORKSPACE_ID,
    workosUserId: "workos_unknown",
    email: "",
    role: "member",
    slug: overrides.id,
    name: "",
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
    pronouns: null,
    phone: null,
    githubUsername: null,
    statusEmoji: null,
    statusText: null,
    _cachedAt: Date.now(),
    ...overrides,
  } as CachedWorkspaceUser
}

function renderDialog(open = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[open ? `/w/${WORKSPACE_ID}?account-switcher=` : `/w/${WORKSPACE_ID}`]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/w/:workspaceId" element={<AccountSwitcherDialog />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe("AccountSwitcherDialog", () => {
  let hrefValues: string[]
  const originalLocation = window.location

  beforeEach(() => {
    vi.restoreAllMocks()
    mockLogin.mockReset()
    mockSwitchAccount.mockReset()

    hrefValues = []
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: "/",
        search: "?account-switcher=",
        set href(v: string) {
          hrefValues.push(v)
        },
        get href() {
          return hrefValues[hrefValues.length - 1] ?? ""
        },
      } as unknown as Location,
    })

    vi.spyOn(authModule, "useAuth").mockReturnValue({
      login: mockLogin,
    } as unknown as ReturnType<typeof authModule.useAuth>)
    vi.spyOn(authModule, "useAccountScope").mockReturnValue({
      activeWorkosUserId: "workos_A",
      switchAccount: mockSwitchAccount,
    } as unknown as ReturnType<typeof authModule.useAccountScope>)
  })

  afterEach(async () => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    await db.workspaceUsers.clear()
    resetWorkspaceStoreCache()
    resetWorkspaceTableRegistry()
  })

  it("renders active, parked, and stale accounts with the right affordances", async () => {
    mockAccounts([
      { id: "workos_A", email: "a@example.com", name: "Ada Active", state: "active" },
      { id: "workos_B", email: "b@example.com", name: "Ben Parked", state: "parked" },
      { id: "stale:alt_1", email: "", name: "", state: "stale" },
    ])

    renderDialog()

    expect(await screen.findByText("Ada Active")).toBeInTheDocument()
    expect(screen.getByLabelText("Current account")).toBeInTheDocument()
    expect(screen.getByText("Ben Parked")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Remove Ben Parked" })).toBeInTheDocument()
    expect(screen.getByText("Signed-out account")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add an account" })).toBeInTheDocument()
  })

  it("flips a parked account in place via switchAccount (no navigation)", async () => {
    mockAccounts([
      { id: "workos_A", email: "a@example.com", name: "Ada Active", state: "active" },
      { id: "workos_B", email: "b@example.com", name: "Ben Parked", state: "parked" },
    ])

    renderDialog()

    await userEvent.click(await screen.findByRole("button", { name: /b@example\.com/ }))

    await waitFor(() => {
      expect(mockSwitchAccount).toHaveBeenCalledWith("workos_B", {
        identity: { id: "workos_B", email: "b@example.com", name: "Ben Parked" },
        landing: "account-home",
      })
    })
    expect(mockLogin).not.toHaveBeenCalled()
    expect(hrefValues).toEqual([])
  })

  it("labels each account by its own profile in this workspace, matched on WorkOS id", async () => {
    // The switcher is the one surface where two of the viewer's own accounts sit
    // side by side, and a WorkOS name is often a stale sign-up name. The match is
    // on `workosUserId` — a name or email match would pick whichever member row
    // happened to share it.
    await db.workspaceUsers.bulkPut([
      workspaceUser({ id: "usr_1", workosUserId: "workos_A", name: "Ada at Work", email: "ada@work.example" }),
      workspaceUser({ id: "usr_2", workosUserId: "workos_B", name: "Ben at Work", email: "ben@work.example" }),
    ])
    mockAccounts([
      { id: "workos_A", email: "a@example.com", name: "Ada Active", state: "active" },
      { id: "workos_B", email: "b@example.com", name: "Ben Parked", state: "parked" },
      // Not a member of this workspace — falls back to the WorkOS identity
      // rather than borrowing another row's label.
      { id: "workos_C", email: "c@example.com", name: "Cleo Elsewhere", state: "parked" },
    ])

    renderDialog()

    expect(await screen.findByText("Ada at Work")).toBeInTheDocument()
    expect(screen.getByText("ada@work.example")).toBeInTheDocument()
    expect(screen.getByText("Ben at Work")).toBeInTheDocument()
    expect(screen.getByText("Cleo Elsewhere")).toBeInTheDocument()
    expect(screen.getByText("c@example.com")).toBeInTheDocument()
    expect(screen.queryByText("Ada Active")).not.toBeInTheDocument()
  })

  it("removes a parked account and refetches the list", async () => {
    const removeSpy = vi.spyOn(accountsApi, "remove").mockResolvedValue({ removedId: "workos_B" })
    vi.spyOn(accountsApi, "list")
      .mockResolvedValueOnce({
        accounts: [
          { id: "workos_A", email: "a@example.com", name: "Ada Active", state: "active" },
          { id: "workos_B", email: "b@example.com", name: "Ben Parked", state: "parked" },
        ],
        maxAccounts: 4,
      })
      .mockResolvedValue({
        accounts: [{ id: "workos_A", email: "a@example.com", name: "Ada Active", state: "active" }],
        maxAccounts: 4,
      })

    renderDialog()

    await userEvent.click(await screen.findByRole("button", { name: "Remove Ben Parked" }))

    expect(removeSpy).toHaveBeenCalledWith("workos_B")
    await waitFor(() => {
      expect(screen.queryByText("Ben Parked")).not.toBeInTheDocument()
    })
  })

  it("removes a stale account by its opaque slot id", async () => {
    const removeSpy = vi.spyOn(accountsApi, "remove").mockResolvedValue({ removedId: "stale:alt_2" })
    mockAccounts([
      { id: "workos_A", email: "a@example.com", name: "Ada Active", state: "active" },
      { id: "stale:alt_2", email: "", name: "", state: "stale" },
    ])

    renderDialog()

    await userEvent.click(await screen.findByRole("button", { name: "Remove stale:alt_2" }))

    expect(removeSpy).toHaveBeenCalledWith("stale:alt_2")
  })

  it("surfaces a switch failure as a toast and stays put", async () => {
    const toastSpy = vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)
    mockSwitchAccount.mockRejectedValue(new Error("Account switch failed (409)"))
    mockAccounts([
      { id: "workos_A", email: "a@example.com", name: "Ada Active", state: "active" },
      { id: "workos_B", email: "b@example.com", name: "Ben Parked", state: "parked" },
    ])

    renderDialog()

    await userEvent.click(await screen.findByRole("button", { name: /b@example\.com/ }))

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith("Account switch failed (409)")
    })
    expect(hrefValues).toEqual([])
  })

  it("starts the add-account OAuth flow from the footer button", async () => {
    mockAccounts([{ id: "workos_A", email: "a@example.com", name: "Ada Active", state: "active" }])

    renderDialog()

    await userEvent.click(await screen.findByRole("button", { name: "Add account" }))

    expect(mockLogin).toHaveBeenCalledWith(undefined, { intent: "add" })
  })

  it("disables Add account at the cap", async () => {
    mockAccounts(
      [
        { id: "workos_A", email: "a@example.com", name: "A", state: "active" },
        { id: "workos_B", email: "b@example.com", name: "B", state: "parked" },
        { id: "workos_C", email: "c@example.com", name: "C", state: "parked" },
        { id: "workos_D", email: "d@example.com", name: "D", state: "parked" },
      ],
      4
    )

    renderDialog()

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled()
    })
  })

  it("shows an error message when the account list fails to load", async () => {
    vi.spyOn(accountsApi, "list").mockRejectedValue(new Error("network down"))

    renderDialog()

    expect(await screen.findByText(/Couldn't load your accounts/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Current account")).not.toBeInTheDocument()
  })

  it("renders nothing when the search param is absent", () => {
    mockAccounts([])
    renderDialog(false)
    expect(screen.queryByText("Switch account")).not.toBeInTheDocument()
  })
})
