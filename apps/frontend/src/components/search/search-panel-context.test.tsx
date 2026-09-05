import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { SidebarProvider } from "@/contexts/sidebar-context"
import { SearchPanelProvider, useSearchPanel } from "./search-panel-context"
import * as analyticsModule from "@/lib/analytics/posthog"

function OpenSearchProbe() {
  const { openSearch } = useSearchPanel()
  return <button onClick={() => openSearch()}>Open search</button>
}

function renderProbe() {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <SearchPanelProvider workspaceId="ws_1">
          <OpenSearchProbe />
        </SearchPanelProvider>
      </SidebarProvider>
    </MemoryRouter>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("SearchPanelProvider analytics", () => {
  it("should capture search_opened when openSearch fires", async () => {
    const capture = vi.spyOn(analyticsModule, "capture").mockImplementation(() => {})
    const user = userEvent.setup()
    renderProbe()

    await user.click(screen.getByRole("button", { name: "Open search" }))

    expect(capture.mock.calls[0]).toEqual(["search_opened"])
  })
})
