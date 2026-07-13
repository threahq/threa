import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PersonaConfigResponse, WorkspaceBootstrap, WorkspacePermissionSlug } from "@threa/types"
import { spyOnExport } from "@/test/spy"
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
  // Peripheral header/test-chat chrome needs providers this focused gate test
  // doesn't set up; stub to no-ops so the body's editor branch is what's asserted.
  spyOnExport(layoutModule, "SidebarToggle").mockReturnValue(
    (() => null) as unknown as typeof layoutModule.SidebarToggle
  )
  spyOnExport(testChatModule, "PersonaTestChatDrawer").mockReturnValue(
    (() => null) as unknown as typeof testChatModule.PersonaTestChatDrawer
  )
  spyOnExport(testChatModule, "PersonaTestChatPane").mockReturnValue(
    (() => null) as unknown as typeof testChatModule.PersonaTestChatPane
  )

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions: options.viewerPermissions,
  } as unknown as WorkspaceBootstrap)

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/ws_1/settings/personas/${PERSONA_ID}`]}>
        <Routes>
          <Route path="/w/:workspaceId/settings/personas/:personaId" element={<PersonaEditorPage />} />
          <Route path="/w/:workspaceId" element={<div>Workspace home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
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
})
