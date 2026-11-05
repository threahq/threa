import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { StreamTypes, type PersonaListItem } from "@threahq/types"
import * as contextsModule from "@/contexts"
import { SettingsProvider } from "@/contexts/settings-context"
import * as rosterHooks from "@/hooks/use-companion-roster"
import * as defaultCompanionHooks from "@/hooks/use-default-companion-persona"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import { PersonalDefaultCompanionSection } from "./ai-settings"
import * as scopeModule from "./use-stream-settings-scope"
import { settingDef } from "./settings-registry"

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

function renderSection(path = "/w/ws_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <SettingsProvider>{children}</SettingsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
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
    expect(screen.getByRole("combobox", { name: settingDef("default-companion").label })).toHaveTextContent(
      /^\W*Ariadne\s*Workspace default$/
    )
  })

  it("stores the picked persona id as the personal override", async () => {
    mockPreferences(null)
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole("combobox", { name: settingDef("default-companion").label }))
    await user.click(await screen.findByRole("option", { name: /Coach/i }))

    expect(updatePreference).toHaveBeenCalledWith("defaultCompanionPersonaId", "persona_coach")
  })

  it("degrades an archived (off-roster) override to the workspace-default option", () => {
    mockPreferences("persona_archived")
    renderSection()
    expect(screen.getByRole("combobox", { name: settingDef("default-companion").label })).toHaveTextContent(
      /^\W*Ariadne\s*Workspace default$/
    )
  })

  it("stores null when the workspace-default option is chosen", async () => {
    mockPreferences("persona_coach")
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole("combobox", { name: settingDef("default-companion").label }))
    await user.click(await screen.findByRole("option", { name: /Workspace default/i }))

    expect(updatePreference).toHaveBeenCalledWith("defaultCompanionPersonaId", null)
  })

  it("links to the scratchpad in view's agent, else to a pick of scratchpad, leaving another stream for it", () => {
    mockPreferences(null)
    const scopeOf = (type: (typeof StreamTypes)[keyof typeof StreamTypes]) => ({
      streamId: "stream_here",
      name: "Here",
      type,
      tabs: ["general", "companion"] as const,
    })
    const linkFrom = (path: string) => {
      const view = renderSection(path)
      const link = screen.queryByRole("link", { name: /scratchpad's agent/ })
      const [hrefPath, query] = link?.getAttribute("href")?.split("?") ?? []
      const target = link && new URLSearchParams(query)
      const result = target && {
        name: link.textContent,
        path: hrefPath,
        page: target.get("stream-settings"),
        stream: target.get("sid"),
        setting: target.get("setting"),
      }
      view.unmount()
      return result
    }
    const scope = vi.spyOn(scopeModule, "useStreamSettingsScope")

    scope.mockReturnValue(scopeOf(StreamTypes.SCRATCHPAD))
    const inScratchpad = linkFrom("/w/ws_1/s/stream_here")
    scope.mockReturnValue(scopeOf(StreamTypes.CHANNEL))
    const inChannel = linkFrom("/w/ws_1/s/stream_here")
    scope.mockReturnValue(null)
    const nowhere = linkFrom("/w/ws_1")

    expect({ inScratchpad, inChannel, nowhere }).toEqual({
      inScratchpad: {
        name: "Change this scratchpad's agent",
        path: "/w/ws_1/s/stream_here",
        page: "companion",
        stream: "stream_here",
        setting: "stream-agent",
      },
      inChannel: {
        name: "Change a scratchpad's agent",
        path: "/w/ws_1",
        page: "companion",
        stream: null,
        setting: "stream-agent",
      },
      nowhere: {
        name: "Change a scratchpad's agent",
        path: "/w/ws_1",
        page: "companion",
        stream: null,
        setting: "stream-agent",
      },
    })
  })
})
