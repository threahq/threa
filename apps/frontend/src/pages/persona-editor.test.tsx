import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PersonaConfigResponse, WorkspaceBootstrap, WorkspacePermissionSlug } from "@threahq/types"
import * as contextsModule from "@/contexts"
import { spyOnExport } from "@/test/spy"
import { MediaGalleryProvider, PanelProvider, SidebarProvider, TraceProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { personasApi } from "@/api"
import type { CachedPersona } from "@/stores/workspace-store"
import * as storeModule from "@/stores/workspace-store"
import * as customEditorModule from "@/components/persona-editor/custom-persona-editor"
import * as builtinEditorModule from "@/components/persona-editor/persona-editor-form"
import * as layoutModule from "@/components/layout"
import * as testChatModule from "@/components/persona-editor/persona-test-chat"
import { PersonaEditorPage } from "./persona-editor"

afterEach(() => vi.restoreAllMocks())

const PERSONA_ID = "persona_target"

function cachedPersona(overrides: Partial<CachedPersona>): CachedPersona {
  return {
    id: PERSONA_ID,
    workspaceId: "ws_1",
    slug: "helper",
    name: "Helper",
    description: null,
    avatarEmoji: null,
    avatarUrl: null,
    systemPrompt: null,
    model: "openrouter:anthropic/claude-haiku-4.5",
    temperature: null,
    maxTokens: null,
    enabledTools: null,
    managedBy: "user",
    ownerUserId: "usr_me",
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    _cachedAt: 0,
    ...overrides,
  }
}

function config(kind: PersonaConfigResponse["kind"]): PersonaConfigResponse {
  // `attachments` is a required field (persona-context-attachments); the page's
  // usePersonaConfig refetchInterval reads it, so the mock must carry it.
  return { kind, resolved: { name: "Helper" }, draft: null, attachments: [] } as unknown as PersonaConfigResponse
}

function renderPage(options: { viewerPermissions: WorkspacePermissionSlug[]; storePersonas?: CachedPersona[] }) {
  vi.spyOn(storeModule, "useWorkspacePersonas").mockReturnValue(options.storePersonas ?? [])
  spyOnExport(customEditorModule, "CustomPersonaEditor").mockReturnValue((() => (
    <div>custom editor</div>
  )) as unknown as typeof customEditorModule.CustomPersonaEditor)
  spyOnExport(builtinEditorModule, "PersonaEditorForm").mockReturnValue((() => (
    <div>built-in editor</div>
  )) as unknown as typeof builtinEditorModule.PersonaEditorForm)
  // Peripheral chrome needs providers this focused test doesn't set up; stub to
  // no-ops so the editor branch and the pane's URL are what's asserted.
  spyOnExport(layoutModule, "SidebarToggle").mockReturnValue(
    (() => null) as unknown as typeof layoutModule.SidebarToggle
  )
  spyOnExport(testChatModule, "PersonaTestChatPane").mockReturnValue((() => (
    <div>test chat pane</div>
  )) as unknown as typeof testChatModule.PersonaTestChatPane)

  // The pane header's focus toggle reads key bindings from preferences, not mounted here.
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: null,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions: options.viewerPermissions,
  } as unknown as WorkspaceBootstrap)

  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider>
          <MemoryRouter initialEntries={[`/w/ws_1/settings/personas/${PERSONA_ID}`]}>
            <TraceProvider>
              <PanelProvider>
                <MediaGalleryProvider>
                  <LocationProbe />
                  <Routes>
                    <Route path="/w/:workspaceId/settings/personas/:personaId" element={<PersonaEditorPage />} />
                    <Route path="/w/:workspaceId" element={<div>Workspace home</div>} />
                  </Routes>
                </MediaGalleryProvider>
              </PanelProvider>
            </TraceProvider>
          </MemoryRouter>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
}

describe("PersonaEditorPage", () => {
  it("redirects a member who owns no matching persona and never fetches the config", () => {
    const getConfig = vi.spyOn(personasApi, "getConfig")
    renderPage({ viewerPermissions: [] })

    expect(screen.getByText("Workspace home")).toBeInTheDocument()
    expect(getConfig).not.toHaveBeenCalled()
  })

  it("lets a member edit their own personal persona and renders the custom editor", async () => {
    const getConfig = vi.spyOn(personasApi, "getConfig").mockResolvedValue(config("personal"))
    renderPage({ viewerPermissions: [], storePersonas: [cachedPersona({})] })

    expect(await screen.findByText("custom editor")).toBeInTheDocument()
    expect(getConfig).toHaveBeenCalledWith("ws_1", PERSONA_ID)
    expect(screen.queryByText("Workspace home")).not.toBeInTheDocument()
  })

  it("redirects a member away from a persona that is not theirs", () => {
    // A workspace/foreign persona never lands a `managed_by='user'` row in the
    // member's store, so ownership is false and the fetch stays disabled.
    const getConfig = vi.spyOn(personasApi, "getConfig")
    renderPage({ viewerPermissions: [], storePersonas: [cachedPersona({ id: "persona_other" })] })

    expect(screen.getByText("Workspace home")).toBeInTheDocument()
    expect(getConfig).not.toHaveBeenCalled()
  })

  it("lets an admin edit a built-in persona via the restricted form", async () => {
    const getConfig = vi.spyOn(personasApi, "getConfig").mockResolvedValue(config("builtin"))
    renderPage({ viewerPermissions: ["workspace:admin"] as WorkspacePermissionSlug[] })

    expect(await screen.findByText("built-in editor")).toBeInTheDocument()
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith("ws_1", PERSONA_ID))
  })

  it("should open the draft's test chat as a URL-backed pane when Test draft is clicked", async () => {
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config("personal"))
    renderPage({ viewerPermissions: [], storePersonas: [cachedPersona({})] })

    fireEvent.click(await screen.findByRole("button", { name: "Test draft" }))

    await waitFor(() =>
      expect(new URLSearchParams(screen.getByTestId("location").textContent!.split("?")[1]).get("panel")).toBe(
        `test:${PERSONA_ID}`
      )
    )
    expect(await screen.findByText("test chat pane")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Test draft" })).toHaveAttribute("aria-pressed", "true")
  })
})
