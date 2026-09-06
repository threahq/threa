import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PersonaListItem } from "@threahq/types"
import type { CachedPersona } from "@/stores/workspace-store"
import { personasApi } from "@/api"
import * as storeModule from "@/stores/workspace-store"
import * as personaHooks from "@/hooks/use-personas"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import { MyPersonasSection } from "./ai-settings"

afterEach(() => vi.restoreAllMocks())

function cachedPersona(overrides: Partial<CachedPersona> & Pick<CachedPersona, "id" | "slug" | "name">): CachedPersona {
  return {
    workspaceId: "ws_1",
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

function archivedItem(overrides: Partial<PersonaListItem> & Pick<PersonaListItem, "id" | "name">): PersonaListItem {
  return {
    slug: "slug",
    description: null,
    avatarEmoji: null,
    model: "openrouter:anthropic/claude-haiku-4.5",
    kind: "personal",
    ownerUserId: "usr_me",
    avatarUrl: null,
    isCustomized: false,
    status: "archived",
    ...overrides,
  }
}

const unarchiveMutate = vi.fn()

function setup(options: { store?: CachedPersona[]; archived?: PersonaListItem[] } = {}) {
  vi.spyOn(storeModule, "useWorkspacePersonas").mockReturnValue(options.store ?? [])
  vi.spyOn(personaHooks, "useArchivedPersonas").mockReturnValue({
    data: options.archived ?? [],
  } as unknown as ReturnType<typeof personaHooks.useArchivedPersonas>)
  vi.spyOn(personaHooks, "useUnarchivePersona").mockReturnValue({
    mutate: unarchiveMutate,
    isPending: false,
  } as unknown as ReturnType<typeof personaHooks.useUnarchivePersona>)
  vi.spyOn(emojiHooks, "useWorkspaceEmoji").mockReturnValue({
    toEmoji: (shortcode: string) => shortcode,
  } as unknown as ReturnType<typeof emojiHooks.useWorkspaceEmoji>)
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<MyPersonasSection workspaceId="ws_1" />} />
          <Route path="/w/:workspaceId/settings/personas/:personaId" element={<div>Editor opened</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("MyPersonasSection", () => {
  beforeEach(() => {
    unarchiveMutate.mockClear()
  })

  it("lists the viewer's active personal personas and excludes non-personal store rows", () => {
    setup({
      store: [
        cachedPersona({ id: "persona_mine", slug: "mine", name: "My helper" }),
        cachedPersona({
          id: "persona_builtin",
          slug: "ariadne",
          name: "Ariadne",
          managedBy: "system",
          ownerUserId: null,
        }),
        cachedPersona({
          id: "persona_custom",
          slug: "coach",
          name: "Coach",
          managedBy: "workspace",
          ownerUserId: null,
        }),
      ],
    })
    renderSection()

    expect(screen.getByText("My helper")).toBeInTheDocument()
    expect(screen.queryByText("Ariadne")).not.toBeInTheDocument()
    expect(screen.queryByText("Coach")).not.toBeInTheDocument()
  })

  it("shows the empty state when the viewer has no personal personas", () => {
    setup({
      store: [
        cachedPersona({
          id: "persona_builtin",
          slug: "ariadne",
          name: "Ariadne",
          managedBy: "system",
          ownerUserId: null,
        }),
      ],
    })
    renderSection()

    expect(screen.getByText(/haven't created any personal personas/i)).toBeInTheDocument()
  })

  it("forks with personal scope and navigates to the new editor from 'New persona'", async () => {
    const fork = vi.spyOn(personasApi, "fork").mockResolvedValue({
      id: "persona_new",
      slug: "new-helper",
      name: "New helper",
      description: null,
      avatarEmoji: null,
      model: "openrouter:anthropic/claude-sonnet-4.6",
      kind: "personal",
      ownerUserId: "usr_me",
      avatarUrl: null,
      isCustomized: false,
      status: "active",
    })
    setup({ store: [cachedPersona({ id: "persona_mine", slug: "mine", name: "My helper" })] })
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole("button", { name: /New persona/ }))
    await user.type(await screen.findByLabelText("Name"), "New helper")
    await user.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() =>
      expect(fork).toHaveBeenCalledWith("ws_1", {
        sourcePersonaId: "persona_mine",
        name: "New helper",
        scope: "personal",
      })
    )
    expect(await screen.findByText("Editor opened")).toBeInTheDocument()
  })

  it("unarchives an archived personal persona and hides workspace-custom archived rows", async () => {
    setup({
      archived: [
        archivedItem({ id: "persona_arch_personal", name: "Archived mine" }),
        archivedItem({ id: "persona_arch_custom", name: "Archived custom", kind: "custom", ownerUserId: null }),
      ],
    })
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole("button", { name: /Archived \(1\)/ }))
    expect(screen.getByText("Archived mine")).toBeInTheDocument()
    expect(screen.queryByText("Archived custom")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Unarchive" }))
    expect(unarchiveMutate).toHaveBeenCalledWith("persona_arch_personal", expect.anything())
  })
})
