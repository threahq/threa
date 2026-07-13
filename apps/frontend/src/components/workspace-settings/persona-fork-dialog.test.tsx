import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PersonaListItem } from "@threa/types"
import { personasApi } from "@/api"
import { PersonaForkDialog } from "./persona-fork-dialog"

afterEach(() => vi.restoreAllMocks())

const sources: PersonaListItem[] = [
  {
    id: "persona_system_ariadne",
    slug: "ariadne",
    name: "Ariadne",
    description: null,
    avatarEmoji: null,
    model: "openrouter:anthropic/claude-sonnet-4.6",
    kind: "builtin",
    ownerUserId: null,
    avatarUrl: null,
    isCustomized: false,
    status: "active",
  },
]

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<PersonaForkDialog workspaceId="ws_1" sources={sources} />} />
          <Route path="/w/:workspaceId/settings/personas/:personaId" element={<div>Editor for new agent</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("PersonaForkDialog", () => {
  it("forks the selected source and navigates to the new agent's editor", async () => {
    const fork = vi
      .spyOn(personasApi, "fork")
      .mockResolvedValue({ id: "persona_new", slug: "research-bot" } as unknown as PersonaListItem)
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: /New agent/ }))
    await user.type(await screen.findByLabelText("Name"), "Research bot")
    await user.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() =>
      expect(fork).toHaveBeenCalledWith("ws_1", { sourcePersonaId: "persona_system_ariadne", name: "Research bot" })
    )
    expect(await screen.findByText("Editor for new agent")).toBeInTheDocument()
  })

  it("sends a null source when Blank agent is picked (start from scratch)", async () => {
    const fork = vi
      .spyOn(personasApi, "fork")
      .mockResolvedValue({ id: "persona_blank", slug: "scribe" } as unknown as PersonaListItem)
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: /New agent/ }))
    await user.click(screen.getByLabelText("Copy from"))
    await user.click(await screen.findByRole("option", { name: /Blank agent/ }))
    await user.type(await screen.findByLabelText("Name"), "Scribe")
    await user.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() => expect(fork).toHaveBeenCalledWith("ws_1", { sourcePersonaId: null, name: "Scribe" }))
  })

  it("disables Create until a name is entered", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: /New agent/ }))
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()
  })
})
