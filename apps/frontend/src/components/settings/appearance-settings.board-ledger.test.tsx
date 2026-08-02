import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AppearanceSettings } from "./appearance-settings"
import * as contextsModule from "@/contexts"
import * as boardViewsModule from "@/hooks/use-board-views"
import {
  DEFAULT_BOARD_FULL_TAIL_COUNT,
  DEFAULT_BOARD_LEDGER_ROWS,
  DEFAULT_BOARD_LEAD_LINE_LENGTH,
  BOARD_LEDGER_ROWS_MAX,
} from "@threa/types"

const WS = "ws_1"

function mount() {
  const updatePreference = vi.fn()
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { accessibility: {} },
    updatePreference,
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
  return { updatePreference }
}

function input(id: string) {
  return document.getElementById(id) as HTMLInputElement
}

describe("AppearanceSettings — board ledger", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("renders the ledger controls seeded from the defaults", () => {
    mount()
    expect(screen.getByText("Board Ledger")).toBeInTheDocument()
    expect(input("board-full-tail-count").value).toBe(String(DEFAULT_BOARD_FULL_TAIL_COUNT))
    expect(input("board-ledger-rows").value).toBe(String(DEFAULT_BOARD_LEDGER_ROWS))
    expect(input("board-lead-line-length").value).toBe(String(DEFAULT_BOARD_LEAD_LINE_LENGTH))
    expect(document.getElementById("board-mass-badge-count-minutes")).toHaveAttribute("data-state", "checked")
  })

  it("commits each number on blur", () => {
    const { updatePreference } = mount()

    fireEvent.change(input("board-full-tail-count"), { target: { value: "3" } })
    fireEvent.blur(input("board-full-tail-count"))
    fireEvent.change(input("board-ledger-rows"), { target: { value: "40" } })
    fireEvent.blur(input("board-ledger-rows"))
    fireEvent.change(input("board-lead-line-length"), { target: { value: "200" } })
    fireEvent.blur(input("board-lead-line-length"))

    expect(updatePreference.mock.calls).toEqual([
      ["boardFullTailCount", 3],
      ["boardLedgerRows", 40],
      ["boardLeadLineLength", 200],
    ])
  })

  it("clamps an out-of-range entry to the bound before writing it", () => {
    const { updatePreference } = mount()

    fireEvent.change(input("board-ledger-rows"), { target: { value: "9999" } })
    fireEvent.blur(input("board-ledger-rows"))

    expect(updatePreference).toHaveBeenCalledWith("boardLedgerRows", BOARD_LEDGER_ROWS_MAX)
    expect(input("board-ledger-rows").value).toBe(String(BOARD_LEDGER_ROWS_MAX))
  })

  it("writes the badge mode on selection", () => {
    const { updatePreference } = mount()

    fireEvent.click(screen.getByLabelText("No badge"))

    expect(updatePreference).toHaveBeenCalledWith("boardMassBadge", "off")
  })
})
