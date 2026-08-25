import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  WORKSPACE_PERMISSION_SCOPES,
  type GitHubWorkspaceIntegration,
  type WorkspaceBootstrap,
  type WorkspacePermissionSlug,
} from "@threa/types"
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
      <IntegrationsTab workspaceId="ws_1" />
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

    const secondRow = (await screen.findByText("kris")).closest("div.rounded-md") as HTMLElement
    await user.click(within(secondRow).getByRole("button", { name: /disconnect/i }))

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

    const secondRow = (await screen.findByText("kris")).closest("div.rounded-md") as HTMLElement
    await user.click(within(secondRow).getByRole("button", { name: /disconnect/i }))

    await waitFor(() => expect(within(secondRow).getByText("GitHub said no")).toBeInTheDocument())
    const firstRow = screen.getByText("acme").closest("div.rounded-md") as HTMLElement
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

    const brokenRow = (await screen.findByText("kris")).closest("div.rounded-md") as HTMLElement
    expect(within(brokenRow).getByRole("link", { name: /reconnect/i })).toBeInTheDocument()
    const healthyRow = screen.getByText("acme").closest("div.rounded-md") as HTMLElement
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

    renderTab(queryClient)

    const orgRow = (await screen.findByText("acme")).closest("div.rounded-md") as HTMLElement
    const userRow = screen.getByText("kris").closest("div.rounded-md") as HTMLElement
    expect(within(orgRow).getByRole("link", { name: /repository access on github/i })).toHaveAttribute(
      "href",
      "https://github.com/organizations/acme/settings/installations/111"
    )
    expect(within(userRow).getByRole("link", { name: /repository access on github/i })).toHaveAttribute(
      "href",
      "https://github.com/settings/installations/222"
    )
  })

  it("omits the repository-access link when the installation has no known configuration page", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])
    vi.spyOn(integrationsApi, "getGithub").mockResolvedValue({
      configured: true,
      integrations: [githubInstall({ id: "wsint_legacy", accountLogin: "acme", configurationUrl: null })],
    })
    vi.spyOn(integrationsApi, "getLinear").mockResolvedValue({ configured: false, integration: null })

    renderTab(queryClient)

    await screen.findByText("acme")
    expect(screen.queryByRole("link", { name: /repository access on github/i })).not.toBeInTheDocument()
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
