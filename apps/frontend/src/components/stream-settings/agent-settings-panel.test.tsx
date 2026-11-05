import { describe, expect, it, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { CompanionModes } from "@threahq/types"
import { render, screen, within } from "@/test"
import { AgentSettingsPanel } from "./agent-settings-panel"

describe("AgentSettingsPanel", () => {
  it("shows what the agent sees under the controls", () => {
    render(
      <AgentSettingsPanel
        companionMode={CompanionModes.ON}
        onCompanionModeChange={vi.fn()}
        contextSummary={<section aria-label="What shapes replies" />}
      />
    )

    expect(screen.getByRole("region", { name: "What shapes replies" })).toBeInTheDocument()
  })

  it("switches agent replies with the named radio group", async () => {
    const onCompanionModeChange = vi.fn()
    render(<AgentSettingsPanel companionMode={CompanionModes.ON} onCompanionModeChange={onCompanionModeChange} />)

    const group = screen.getByRole("radiogroup", { name: "Agent replies" })
    await userEvent.click(within(group).getByRole("radio", { name: "Quiet" }))

    expect(onCompanionModeChange).toHaveBeenCalledWith(CompanionModes.OFF)
  })
})
