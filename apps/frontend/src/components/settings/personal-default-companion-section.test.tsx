import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { PersonaListItem } from "@threa/types"
import * as contextsModule from "@/contexts"
import * as rosterHooks from "@/hooks/use-companion-roster"
import * as defaultCompanionHooks from "@/hooks/use-default-companion-persona"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import { PersonalDefaultCompanionSection } from "./ai-settings"

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

const updatePreference = vi.fn().mockResolvedValue(undefined)

function mockPreferences(defaultCompanionPersonaId: string | null) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { defaultCompanionPersonaId },
    updatePreference,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  return render(<PersonalDefaultCompanionSection workspaceId="ws_1" />, { wrapper: Wrapper })
}

describe("PersonalDefaultCompanionSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockClear()
    vi.spyOn(rosterHooks, "useCompanionRoster").mockReturnValue([ARIADNE, COACH])
    vi.spyOn(defaultCompanionHooks, "useDefaultCompanionPersona").mockReturnValue({
      effectiveDefault: ARIADNE,
      workspaceDefault: ARIADNE,
      personalDefault: undefined,
    })
    vi.spyOn(emojiHooks, "useWorkspaceEmoji").mockReturnValue({
      toEmoji: (shortcode: string) => shortcode,
    } as unknown as ReturnType<typeof emojiHooks.useWorkspaceEmoji>)
  })

  it("shows the workspace-default synthetic option when no personal override is set", () => {
    mockPreferences(null)
    renderSection()
    expect(screen.getByRole("combobox", { name: /companion agent/i })).toHaveTextContent(
      /Workspace default \(Ariadne\)/i
    )
  })

  it("stores the picked persona id as the personal override", async () => {
    mockPreferences(null)
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await user.click(await screen.findByRole("option", { name: /Coach/i }))

    expect(updatePreference).toHaveBeenCalledWith("defaultCompanionPersonaId", "persona_coach")
  })

  it("degrades an archived (off-roster) override to the workspace-default option", () => {
    mockPreferences("persona_archived")
    renderSection()
    expect(screen.getByRole("combobox", { name: /companion agent/i })).toHaveTextContent(
      /Workspace default \(Ariadne\)/i
    )
  })

  it("stores null when the workspace-default option is chosen", async () => {
    mockPreferences("persona_coach")
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await user.click(await screen.findByRole("option", { name: /Workspace default/i }))

    expect(updatePreference).toHaveBeenCalledWith("defaultCompanionPersonaId", null)
  })
})
