import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { BoardSettings } from "./inbox-settings"
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
        <Route path="/w/:workspaceId/settings" element={<BoardSettings />} />
      </Routes>
    </MemoryRouter>
  )
}

async function boardHomeOptions() {
  await userEvent.click(screen.getByRole("combobox", { name: "Default view" }))
  return screen.getAllByRole("option")
}

function optionName(option: HTMLElement) {
  return document.getElementById(option.getAttribute("aria-labelledby") ?? "")?.textContent
}

describe("BoardSettings — board home", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("offers exactly the two board lenses", async () => {
    mount("all")
    expect((await boardHomeOptions()).map((el) => [optionName(el), el.textContent])).toEqual([
      ["All", "AllEverything, newest activity first."],
      ["Mine", "MineConversations you're in or mentioned in."],
    ])
  })

  it("degrades a retired stored home lens to the default rather than selecting nothing", async () => {
    // A preference blob written before the Decisions lens was dropped still says
    // `decisions`. It must land on All, not blank the section or throw.
    mount("decisions")
    expect((await boardHomeOptions()).map((el) => [optionName(el), el.getAttribute("aria-selected")])).toEqual([
      ["All", "true"],
      ["Mine", "false"],
    ])
  })
})
