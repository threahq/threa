import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "@threa/types"
import * as draftHook from "@/hooks/use-draft-scratchpads"
import * as personasHooks from "@/hooks/use-personas"
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
  vi.spyOn(personasHooks, "usePersonas").mockReturnValue({
    data: ROSTER,
  } as unknown as ReturnType<typeof personasHooks.usePersonas>)
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
    <TooltipProvider>
      <DraftAgentSettings
        workspaceId="ws_1"
        draftId="draft_1"
        companionMode={opts.companionMode ?? "on"}
        allowedToolCategories={opts.allowedToolCategories ?? null}
        configuredCategories={opts.configuredCategories}
      />
    </TooltipProvider>
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

    await userEvent.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await userEvent.click(screen.getByRole("option", { name: /coach/i }))

    expect(updateScratchpad).toHaveBeenCalledWith("draft_1", { companionPersonaId: "persona_coach" })
  })

  it("hides the picker while the roster is still loading", () => {
    vi.spyOn(personasHooks, "usePersonas").mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof personasHooks.usePersonas>)

    renderSettings({})

    expect(screen.queryByRole("combobox", { name: /companion agent/i })).not.toBeInTheDocument()
  })
})
