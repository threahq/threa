import type { ReactElement } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, useLocation } from "react-router-dom"
import type { WorkspaceBootstrap, WorkspacePermissionSlug, WorkspaceSettings } from "@threahq/types"
import { render } from "@/test"
import { SettingsProvider } from "@/contexts"
import { workspaceKeys } from "@/hooks/use-workspaces"

export const TEST_WORKSPACE_ID = "ws_1"

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

/**
 * Mounts a workspace settings page inside the providers the settings window
 * gives it. `permissions: null` leaves the bootstrap unloaded.
 */
export function renderWorkspaceSettings(
  ui: ReactElement,
  {
    permissions,
    settings = {},
    route = "/?settings=workspace-defaults",
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }: {
    permissions: WorkspacePermissionSlug[] | null
    settings?: Partial<WorkspaceSettings>
    route?: string
    queryClient?: QueryClient
  }
) {
  if (permissions !== null) {
    queryClient.setQueryData(workspaceKeys.bootstrap(TEST_WORKSPACE_ID), {
      viewerPermissions: permissions,
      workspaceSettings: settings as WorkspaceSettings,
    } as unknown as WorkspaceBootstrap)
  }
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <SettingsProvider>{ui}</SettingsProvider>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { ...result, queryClient }
}
