import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "@threa/types"
import * as draftHook from "@/hooks/use-draft-scratchpads"
import { DraftAgentSettings } from "./draft-agent-settings"

const updateScratchpad = vi.fn()

beforeEach(() => {
  updateScratchpad.mockReset()
  vi.spyOn(draftHook, "useDraftScratchpads").mockReturnValue({
    scratchpads: [],
    createScratchpad: vi.fn(),
    updateScratchpad,
    deleteScratchpad: vi.fn(),
    getScratchpad: vi.fn(),
  } as unknown as ReturnType<typeof draftHook.useDraftScratchpads>)
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
})
