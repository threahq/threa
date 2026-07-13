import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  WORKSPACE_PERMISSION_SCOPES,
  type PersonaListItem,
  type WorkspaceBootstrap,
  type WorkspaceSettings,
  type WorkspacePermissionSlug,
} from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { workspaceSettingsApi } from "@/api"
import * as personasHooks from "@/hooks/use-personas"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import { DefaultCompanionSection } from "./default-companion-section"

function persona(overrides: Partial<PersonaListItem> & Pick<PersonaListItem, "id" | "slug" | "name">): PersonaListItem {
  return {
    description: null,
    avatarEmoji: null,
    model: "openrouter:anthropic/claude-haiku-4.5",
    kind: "custom",
    ownerUserId: null,
    avatarUrl: null,
    isCustomized: false,
    status: "active",
    ...overrides,
  }
}

const ARIADNE = persona({ id: "persona_ariadne", slug: "ariadne", name: "Ariadne", kind: "builtin" })
const COACH = persona({ id: "persona_coach", slug: "coach", name: "Coach", avatarEmoji: "🏋️" })

function seedBootstrap(
  queryClient: QueryClient,
  viewerPermissions: WorkspacePermissionSlug[],
  defaultCompanionPersonaId: string | null
) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
    workspaceSettings: { defaultCompanionPersonaId } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
}

function renderSection(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DefaultCompanionSection workspaceId="ws_1" />
    </QueryClientProvider>
  )
}

describe("DefaultCompanionSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(personasHooks, "usePersonas").mockReturnValue({
      data: [ARIADNE, COACH],
    } as unknown as ReturnType<typeof personasHooks.usePersonas>)
    vi.spyOn(emojiHooks, "useWorkspaceEmoji").mockReturnValue({
      toEmoji: (shortcode: string) => shortcode,
    } as unknown as ReturnType<typeof emojiHooks.useWorkspaceEmoji>)
  })

  it("shows Ariadne for a null setting and saves the picked persona id", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], null)
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ defaultCompanionPersonaId: "persona_coach" } as WorkspaceSettings)
    const user = userEvent.setup()

    renderSection(queryClient)
    const combobox = screen.getByRole("combobox", { name: /companion agent/i })
    expect(combobox).toHaveTextContent("Ariadne")

    await user.click(combobox)
    await user.click(await screen.findByRole("option", { name: /Coach/i }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { defaultCompanionPersonaId: "persona_coach" }))
  })

  it("rolls the optimistic cache patch back and toasts on a rejected save", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], null)
    vi.spyOn(workspaceSettingsApi, "update").mockRejectedValue(new Error("Persona not available"))
    const toastError = vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)
    const user = userEvent.setup()

    renderSection(queryClient)
    await user.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await user.click(await screen.findByRole("option", { name: /Coach/i }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to save the default companion"))
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.workspaceSettings?.defaultCompanionPersonaId).toBeNull()
  })

  it("shows the resolved default read-only to a non-admin", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seedBootstrap(queryClient, [], "persona_coach")

    renderSection(queryClient)

    expect(screen.queryByRole("combobox", { name: /companion agent/i })).not.toBeInTheDocument()
    expect(screen.getByText("Coach")).toBeInTheDocument()
  })
})
