import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "@threahq/types"
import * as draftHook from "@/hooks/use-draft-scratchpads"
import * as rosterHooks from "@/hooks/use-companion-roster"
import * as defaultCompanionHooks from "@/hooks/use-default-companion-persona"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import { DraftAgentSettings } from "./draft-agent-settings"

const updateScratchpad = vi.fn()

const ROSTER = [
  {
    id: "persona_ariadne",
    slug: "ariadne",
    name: "Ariadne",
    description: null,
    avatarEmoji: null,
    model: "openrouter:anthropic/claude-sonnet-5",
    kind: "builtin",
    avatarUrl: null,
    isCustomized: false,
  },
  {
    id: "persona_coach",
    slug: "coach",
    name: "Coach",
    description: null,
    avatarEmoji: "🏋️",
    model: "openrouter:anthropic/claude-haiku-4.5",
    kind: "custom",
    avatarUrl: null,
    isCustomized: false,
  },
]

beforeEach(() => {
  updateScratchpad.mockReset()
  vi.spyOn(draftHook, "useDraftScratchpads").mockReturnValue({
    scratchpads: [],
    createScratchpad: vi.fn(),
    updateScratchpad,
    deleteScratchpad: vi.fn(),
    getScratchpad: vi.fn(),
  } as unknown as ReturnType<typeof draftHook.useDraftScratchpads>)
  vi.spyOn(rosterHooks, "useCompanionRoster").mockReturnValue(
    ROSTER as unknown as ReturnType<typeof rosterHooks.useCompanionRoster>
  )
  vi.spyOn(defaultCompanionHooks, "useDefaultCompanionPersona").mockReturnValue({
    effectiveDefault: ROSTER[0],
    workspaceDefault: ROSTER[0],
  } as unknown as ReturnType<typeof defaultCompanionHooks.useDefaultCompanionPersona>)
  vi.spyOn(emojiHooks, "useWorkspaceEmoji").mockReturnValue({
    toEmoji: (shortcode: string) => shortcode,
  } as unknown as ReturnType<typeof emojiHooks.useWorkspaceEmoji>)
})

function renderSettings(opts: {
  companionMode?: "on" | "off"
  allowedToolCategories?: ToolPrivacyPolicy
  configuredCategories?: ToolPrivacyCategory[]
}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <DraftAgentSettings
          workspaceId="ws_1"
          draftId="draft_1"
          companionMode={opts.companionMode ?? "on"}
          allowedToolCategories={opts.allowedToolCategories ?? null}
          configuredCategories={opts.configuredCategories}
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("DraftAgentSettings", () => {
  it("writes the companion mode choice to the draft", async () => {
    renderSettings({ companionMode: "on" })

    await userEvent.click(screen.getByRole("radio", { name: /quiet/i }))

    expect(updateScratchpad).toHaveBeenCalledWith("draft_1", { companionMode: "off" })
  })

  it("writes a restricted (empty) policy to the draft when restriction is turned on", async () => {
    renderSettings({ allowedToolCategories: null })

    await userEvent.click(screen.getByRole("switch", { name: /restrict tool access/i }))

    expect(updateScratchpad).toHaveBeenCalledWith("draft_1", { allowedToolCategories: [] })
  })

  it("only offers the categories the workspace has configured", () => {
    renderSettings({ allowedToolCategories: [], configuredCategories: ["web", "workspace"] })

    expect(screen.getByRole("checkbox", { name: /web/i })).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /github/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /linear/i })).not.toBeInTheDocument()
  })

  it("writes the picked companion persona to the draft", async () => {
    renderSettings({})

    await userEvent.click(screen.getByRole("combobox", { name: "Agent" }))
    await userEvent.click(screen.getByRole("option", { name: /coach/i }))

    expect(updateScratchpad).toHaveBeenCalledWith("draft_1", { companionPersonaId: "persona_coach" })
  })

  it("draws the row following the default like a persona row: the agent, then its tier, named once", async () => {
    vi.spyOn(defaultCompanionHooks, "useDefaultCompanionPersona").mockReturnValue({
      effectiveDefault: ROSTER[1],
      workspaceDefault: ROSTER[0],
      personalDefault: ROSTER[1],
    } as unknown as ReturnType<typeof defaultCompanionHooks.useDefaultCompanionPersona>)
    renderSettings({})

    const trigger = screen.getByRole("combobox", { name: "Agent" })
    await userEvent.click(trigger)
    expect({
      trigger: trigger.textContent,
      options: screen.getAllByRole("option").map((option) => option.textContent),
    }).toEqual({
      trigger: "🏋️CoachYour default",
      options: ["🏋️CoachYour default", "Ariadne", "🏋️Coach"],
    })
  })

  it("keeps the picker mounted but disabled while the store is still hydrating (empty roster)", () => {
    vi.spyOn(rosterHooks, "useCompanionRoster").mockReturnValue([])

    renderSettings({})

    // The section must not pop in and shift the sheet once the roster resolves
    // (INV-21) — the trigger renders at full size, disabled, with no premature
    // default row as its value.
    const trigger = screen.getByRole("combobox", { name: "Agent" })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent("Loading agents…")
  })
})
