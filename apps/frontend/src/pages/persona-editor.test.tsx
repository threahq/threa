import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorkspaceBootstrap, WorkspacePermissionSlug } from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { personasApi } from "@/api"
import { PersonaEditorPage } from "./persona-editor"

afterEach(() => vi.restoreAllMocks())

function renderPage(viewerPermissions: WorkspacePermissionSlug[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
  } as unknown as WorkspaceBootstrap)
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/settings/personas/persona_system_ariadne"]}>
        <Routes>
          <Route path="/w/:workspaceId/settings/personas/:personaId" element={<PersonaEditorPage />} />
          <Route path="/w/:workspaceId" element={<div>Workspace home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("PersonaEditorPage", () => {
  it("redirects a non-admin away from the editor and never fetches the admin config", () => {
    const getConfig = vi.spyOn(personasApi, "getConfig")
    renderPage([])

    expect(screen.getByText("Workspace home")).toBeInTheDocument()
    expect(getConfig).not.toHaveBeenCalled()
  })
})
