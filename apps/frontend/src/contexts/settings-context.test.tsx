import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { SettingsProvider, useSettings } from "./settings-context"

function Probe() {
  const { activeTab } = useSettings()
  const location = useLocation()
  return (
    <output data-testid="probe">
      {activeTab ?? "overview"} {location.search}
    </output>
  )
}

function renderAt(search: string) {
  render(
    <MemoryRouter initialEntries={[`/w/ws_1${search}`]}>
      <Routes>
        <Route
          path="/w/:workspaceId/*"
          element={
            <SettingsProvider>
              <Probe />
            </SettingsProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe("SettingsProvider legacy links", () => {
  it.each([
    ["?settings=dictation", "voice ?settings=voice"],
    ["?settings=calls", "voice ?settings=voice"],
    ["?settings=schedule", "datetime ?settings=datetime"],
    ["?settings=accessibility", "appearance ?settings=appearance"],
    ["?settings=diagnostics", "privacy ?settings=privacy"],
    ["?ws-settings=members", "members ?settings=members"],
    ["?ws-settings=personas", "workspace-ai ?settings=workspace-ai"],
    ["?ws-settings=ai-agents", "workspace-ai ?settings=workspace-ai"],
    ["?ws-settings=bots&bot=bot_1", "bots ?settings=bots&bot=bot_1"],
    ["?ws-settings=integrations&provider=github", "integrations ?settings=integrations"],
  ])("should open %s on the page it became", async (search, expected) => {
    renderAt(search)

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe(expected))
  })
})
