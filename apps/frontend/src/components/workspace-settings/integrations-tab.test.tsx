import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import {
  WORKSPACE_PERMISSION_SCOPES,
  type GitHubWorkspaceIntegration,
  type WorkspaceBootstrap,
  type WorkspacePermissionSlug,
} from "@threahq/types"
import { ApiError } from "@/api/client"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { integrationsApi } from "@/api/integrations"
import { IntegrationsTab } from "./integrations-tab"

function seedBootstrap(queryClient: QueryClient, viewerPermissions: WorkspacePermissionSlug[]) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
  } as unknown as WorkspaceBootstrap)
}

function githubInstall(overrides: Partial<GitHubWorkspaceIntegration>): GitHubWorkspaceIntegration {
  return {
    id: "wsint_1",
    workspaceId: "ws_1",
    provider: "github",
    status: "active",
    installedBy: "usr_1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    accountLogin: "acme",
    installationId: "111",
    accountType: "Organization",
    repositorySelection: "all",
    configurationUrl: "https://github.com/organizations/acme/settings/installations/111",
    permissions: {},
    repositories: [],
    rateLimit: { remaining: null, resetAt: null },
    ...overrides,
  }
}

function renderTab(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IntegrationsTab workspaceId="ws_1" />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("IntegrationsTab GitHub installations", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("renders one row per installation", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({
      configured: true,
      integrations: [
        githubInstall({ id: "wsint_org", accountLogin: "acme", accountType: "Organization" }),
        githubInstall({ id: "wsint_user", accountLogin: "kris", accountType: "User" }),
      ],
    })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })

    renderTab(queryClient)

    expect(await screen.findByText("acme")).toBeInTheDocument()
    expect(screen.getByText("kris")).toBeInTheDocument()
    expect(screen.getByText("Personal")).toBeInTheDocument()
    expect(screen.getByText("Organization")).toBeInTheDocument()
  })

  it("disconnects the row whose button was clicked, by its own id", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({
      configured: true,
      integrations: [
        githubInstall({ id: "wsint_org", accountLogin: "acme" }),
        githubInstall({ id: "wsint_user", accountLogin: "kris", accountType: "User" }),
      ],
    })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })
    const disconnect = vi.spyOn(integrationsApi, "disconnectGithub").mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderTab(queryClient)

    await user.click(await screen.findByRole("button", { name: "Actions for kris" }))
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }))

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("ws_1", "wsint_user"))
    expect(disconnect).not.toHaveBeenCalledWith("ws_1", "wsint_org")
  })

  it("shows the add-installation button when installs already exist", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({
      configured: true,
      integrations: [githubInstall({ id: "wsint_org", accountLogin: "acme" })],
    })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })

    renderTab(queryClient)

    expect(await screen.findByRole("link", { name: /add organization or account/i })).toBeInTheDocument()
  })

  it("renders a failed disconnect inside the row that was acted on", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({
      configured: true,
      integrations: [
        githubInstall({ id: "wsint_org", accountLogin: "acme" }),
        githubInstall({ id: "wsint_user", accountLogin: "kris", accountType: "User" }),
      ],
    })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })
    vi.spyOn(integrationsApi, "disconnectGithub").mockRejectedValue(new Error("GitHub said no"))
    const user = userEvent.setup()

    renderTab(queryClient)

    const secondRow = (await screen.findByText("kris")).closest("li") as HTMLElement
    await user.click(within(secondRow).getByRole("button", { name: "Actions for kris" }))
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }))

    await waitFor(() => expect(within(secondRow).getByText("GitHub said no")).toBeInTheDocument())
    const firstRow = screen.getByText("acme").closest("li") as HTMLElement
    expect(within(firstRow).queryByText("GitHub said no")).not.toBeInTheDocument()
  })

  it("offers Reconnect on an errored installation", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({
      configured: true,
      integrations: [
        githubInstall({ id: "wsint_ok", accountLogin: "acme" }),
        githubInstall({ id: "wsint_broken", accountLogin: "kris", accountType: "User", status: "error" }),
      ],
    })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })

    renderTab(queryClient)

    const brokenRow = (await screen.findByText("kris")).closest("li") as HTMLElement
    expect(within(brokenRow).getByRole("link", { name: /reconnect/i })).toBeInTheDocument()
    const healthyRow = screen.getByText("acme").closest("li") as HTMLElement
    expect(within(healthyRow).queryByRole("link", { name: /reconnect/i })).not.toBeInTheDocument()
  })

  it("links each installation to its own GitHub repository-access page", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({
      configured: true,
      integrations: [
        githubInstall({
          id: "wsint_org",
          accountLogin: "acme",
          configurationUrl: "https://github.com/organizations/acme/settings/installations/111",
        }),
        githubInstall({
          id: "wsint_user",
          accountLogin: "kris",
          accountType: "User",
          configurationUrl: "https://github.com/settings/installations/222",
        }),
      ],
    })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })

    const user = userEvent.setup()

    renderTab(queryClient)

    const hrefs: (string | null)[] = []
    for (const account of ["acme", "kris"]) {
      await user.click(await screen.findByRole("button", { name: `Actions for ${account}` }))
      hrefs.push((await screen.findByRole("menuitem", { name: "Repository access on GitHub" })).getAttribute("href"))
      await user.keyboard("{Escape}")
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    }
    expect(hrefs).toEqual([
      "https://github.com/organizations/acme/settings/installations/111",
      "https://github.com/settings/installations/222",
    ])
  })

  it("omits the repository-access link when the installation has no known configuration page", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({
      configured: true,
      integrations: [githubInstall({ id: "wsint_legacy", accountLogin: "acme", configurationUrl: null })],
    })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })

    const user = userEvent.setup()

    renderTab(queryClient)

    await user.click(await screen.findByRole("button", { name: "Actions for acme" }))
    expect({
      items: (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    }).toEqual({ items: ["Disconnect"] })
  })

  it("refetches after a gone installation, but leaves the row alone on a transient sync failure", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    const getGithub = vi
      .spyOn(integrationsApi, "getGithub")
      .mockResolvedValue({ configured: true, integrations: [githubInstall({ id: "wsint_1", accountLogin: "acme" })] })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })
    vi.spyOn(integrationsApi, "syncGithub").mockRejectedValue(
      new ApiError(502, "GITHUB_SYNC_FAILED", "Failed to sync GitHub repositories")
    )

    renderTab(queryClient)
    await screen.findByText("acme")
    const fetchesBefore = getGithub.mock.calls.length

    await userEvent.click(screen.getByRole("button", { name: /sync repos/i }))

    // The message stands on its own; a refetch here would resolve back to
    // Connected and strand it with nothing to clear it.
    await waitFor(() => expect(screen.getByText("Failed to sync GitHub repositories")).toBeInTheDocument())
    expect(getGithub.mock.calls.length).toBe(fetchesBefore)

    vi.mocked(integrationsApi.syncGithub).mockRejectedValue(
      new ApiError(409, "GITHUB_INSTALLATION_GONE", "This GitHub installation no longer exists.")
    )
    getGithub.mockResolvedValue({
      configured: true,
      integrations: [githubInstall({ id: "wsint_1", accountLogin: "acme", status: "error" })],
    })

    await userEvent.click(screen.getByRole("button", { name: /sync repos/i }))

    expect(await screen.findByText("Error")).toBeInTheDocument()
    expect(getGithub.mock.calls.length).toBeGreaterThan(fetchesBefore)
  })

  it("keeps a single Connect button in the empty state", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({ configured: true, integrations: [] })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })

    renderTab(queryClient)

    expect(await screen.findByRole("link", { name: /connect github/i })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /add organization or account/i })).not.toBeInTheDocument()
  })
})

describe("IntegrationsTab permissions", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps each provider's purpose and an inactive Connect, with the reason, when this installation can't connect it", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({ configured: false, integrations: [] })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })
    const user = userEvent.setup()

    renderTab(queryClient)

    const connectGithub = await screen.findByRole("button", { name: "Connect GitHub" })
    const connectLinear = screen.getByRole("button", { name: "Connect Linear" })
    await user.click(connectGithub)
    await user.tab()

    expect({
      github: {
        disabled: connectGithub.getAttribute("aria-disabled"),
        description: connectGithub.getAttribute("aria-describedby"),
        reason: document.getElementById("setting-github-integration-reason")?.textContent,
        purpose: document.getElementById("setting-github-integration-description")?.textContent,
      },
      linear: {
        disabled: connectLinear.getAttribute("aria-disabled"),
        reason: document.getElementById("setting-linear-integration-reason")?.textContent,
        purpose: document.getElementById("setting-linear-integration-description")?.textContent,
      },
      focusMovedOnToLinear: document.activeElement === connectLinear,
      links: screen.queryAllByRole("link").length,
    }).toEqual({
      github: {
        disabled: "true",
        description: "setting-github-integration-description setting-github-integration-reason",
        reason: "Turned off for this Threa installation.",
        purpose: "Rich previews for GitHub links.",
      },
      linear: {
        disabled: "true",
        reason: "Turned off for this Threa installation.",
        purpose: "Rich previews for Linear links.",
      },
      focusMovedOnToLinear: true,
      links: 0,
    })
  })

  it("puts each provider's state first in its row, with its action beside it", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({ configured: true, integrations: [] })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: true, integration: null })

    renderTab(queryClient)

    expect({
      github: (await screen.findByText("Not connected. Rich previews for GitHub links.")) !== null,
      linear: screen.getByText("Not connected. Rich previews for Linear links.") !== null,
      actions: screen.getAllByRole("link").map((link) => link.textContent),
      bands: screen.queryAllByRole("group"),
    }).toEqual({ github: true, linear: true, actions: ["Connect GitHub", "Connect Linear"], bands: [] })
  })

  it("tells a non-admin why there is nothing to manage, without querying the integrations", () => {
    const github = vi.spyOn(integrationsApi, "getGithub")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seedBootstrap(queryClient, [])

    renderTab(queryClient)

    expect({
      reasons: screen.queryAllByText(/^Only workspace admins can connect/).map((reason) => reason.textContent),
      fetched: github.mock.calls.length,
    }).toEqual({
      reasons: ["Only workspace admins can connect GitHub.", "Only workspace admins can connect Linear."],
      fetched: 0,
    })
  })

  it("claims no restriction while permissions are still loading", () => {
    renderTab(new QueryClient({ defaultOptions: { queries: { retry: false } } }))

    expect(screen.queryAllByText(/^Only workspace admins can connect/)).toEqual([])
  })
})
