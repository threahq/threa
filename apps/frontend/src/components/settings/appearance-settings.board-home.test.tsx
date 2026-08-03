import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AppearanceSettings } from "./appearance-settings"
import * as contextsModule from "@/contexts"
import * as boardViewsModule from "@/hooks/use-board-views"

const WS = "ws_1"

function mount(boardDefaultLens: string) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { boardDefaultLens, accessibility: {} },
    updatePreference: vi.fn(),
    updatePreferences: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(boardViewsModule, "useBoardViews").mockReturnValue({ data: [] } as unknown as ReturnType<
    typeof boardViewsModule.useBoardViews
  >)
  vi.spyOn(boardViewsModule, "useBoardHome").mockReturnValue({ view: null } as unknown as ReturnType<
    typeof boardViewsModule.useBoardHome
  >)
  render(
    <MemoryRouter initialEntries={[`/w/${WS}/settings`]}>
      <Routes>
        <Route path="/w/:workspaceId/settings" element={<AppearanceSettings />} />
      </Routes>
    </MemoryRouter>
  )
}

describe("AppearanceSettings — board home", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("offers exactly the two board lenses", () => {
    mount("all")
    const options = screen.getAllByRole("radio").filter((el) => el.id.startsWith("board-home-lens-"))
    expect(options.map((el) => el.id)).toEqual(["board-home-lens-all", "board-home-lens-mine"])
  })

  it("degrades a retired stored home lens to the default rather than selecting nothing", () => {
    // A preference blob written before the Decisions lens was dropped still says
    // `decisions`. It must land on All, not blank the section or throw.
    mount("decisions")
    expect(screen.getByText("Board home")).toBeInTheDocument()
    expect(document.getElementById("board-home-lens-all")).toHaveAttribute("data-state", "checked")
  })
})
