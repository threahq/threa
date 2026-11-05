import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { BoardSettings } from "./inbox-settings"
import { settingDef } from "./settings-registry"
import * as contextsModule from "@/contexts"
import * as boardViewsModule from "@/hooks/use-board-views"
import {
  DEFAULT_BOARD_FULL_TAIL_COUNT,
  DEFAULT_BOARD_LEDGER_ROWS,
  DEFAULT_BOARD_LEAD_LINE_LENGTH,
  BOARD_LEDGER_ROWS_MAX,
  BOARD_LEDGER_ROWS_MIN,
} from "@threahq/types"

const WS = "ws_1"

function mount(preferences: Record<string, unknown> = {}, { openLedger = true } = {}) {
  const updatePreference = vi.fn()
  const updatePreferences = vi.fn()
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { accessibility: {}, ...preferences },
    updatePreference,
    updatePreferences,
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
  if (openLedger) fireEvent.click(screen.getByRole("button", { name: /Older messages on cards/ }))
  return { updatePreference, updatePreferences }
}

const fullTail = () => screen.getByRole("spinbutton", { name: settingDef("board-full-tail").label }) as HTMLInputElement
const ledgerRows = () =>
  screen.getByRole("spinbutton", { name: settingDef("board-ledger-rows").label }) as HTMLInputElement
const leadLine = () => screen.getByRole("spinbutton", { name: settingDef("board-lead-line").label }) as HTMLInputElement

function badgeOptions() {
  return within(screen.getByRole("radiogroup", { name: settingDef("board-head-badge").label }))
    .getAllByRole("radio")
    .map((el) => [el.textContent, el.getAttribute("data-state")])
}

describe("BoardSettings — board", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("keeps the ledger knobs closed behind a summary of their values", () => {
    mount({ boardFullTailCount: 2, boardLedgerRows: 4, boardLeadLineLength: 60 }, { openLedger: false })
    const disclosure = screen.getByRole("button", { name: /Older messages on cards/ })
    expect({
      expanded: disclosure.getAttribute("aria-expanded"),
      summary: disclosure.textContent,
      knobs: screen.queryByRole("spinbutton", { name: settingDef("board-ledger-rows").label }),
    }).toEqual({
      expanded: "false",
      summary: "Older messages on cards2 newest in full, then 4 one-line summaries of up to 60 characters",
      knobs: null,
    })
  })

  it("renders the ledger controls seeded from the defaults", () => {
    mount()
    expect({
      fullTail: fullTail().value,
      ledgerRows: ledgerRows().value,
      leadLine: leadLine().value,
      badge: badgeOptions(),
    }).toEqual({
      fullTail: String(DEFAULT_BOARD_FULL_TAIL_COUNT),
      ledgerRows: String(DEFAULT_BOARD_LEDGER_ROWS),
      leadLine: String(DEFAULT_BOARD_LEAD_LINE_LENGTH),
      badge: [
        ["Unread count", "checked"],
        ["None", "unchecked"],
      ],
    })
  })

  it("shows a stored count-minutes row as the count mode", () => {
    mount({ boardMassBadge: "count-minutes" })
    expect(badgeOptions()).toEqual([
      ["Unread count", "checked"],
      ["None", "unchecked"],
    ])
  })

  it("commits each number on blur", () => {
    const { updatePreference } = mount()

    fireEvent.change(fullTail(), { target: { value: "3" } })
    fireEvent.blur(fullTail())
    fireEvent.change(ledgerRows(), { target: { value: "40" } })
    fireEvent.blur(ledgerRows())
    fireEvent.change(leadLine(), { target: { value: "200" } })
    fireEvent.blur(leadLine())

    expect(updatePreference.mock.calls).toEqual([
      ["boardFullTailCount", 3],
      ["boardLedgerRows", 40],
      ["boardLeadLineLength", 200],
    ])
  })

  it("keeps an out-of-range entry with an error naming the range instead of writing it", () => {
    const { updatePreference } = mount()

    fireEvent.change(ledgerRows(), { target: { value: "9999" } })
    fireEvent.blur(ledgerRows())

    expect({
      writes: updatePreference.mock.calls,
      value: ledgerRows().value,
      error: screen.getByRole("alert").textContent,
    }).toEqual({
      writes: [],
      value: "9999",
      error: `Enter a whole number from ${BOARD_LEDGER_ROWS_MIN} to ${BOARD_LEDGER_ROWS_MAX}.`,
    })
  })

  it("writes the badge mode on selection", () => {
    const { updatePreference } = mount()

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: settingDef("board-head-badge").label })).getByRole("radio", {
        name: "None",
      })
    )

    expect(updatePreference).toHaveBeenCalledWith("boardMassBadge", "off")
  })

  it("picks folding as one choice, Never or a height", () => {
    const { updatePreference } = mount({
      boardCardCollapseEnabled: false,
      boardCardCollapseAtHeight: 450,
      boardCardCollapseToHeight: 300,
    })
    const choice = screen.getByRole("radiogroup", { name: settingDef("board-card-collapse").label })
    fireEvent.click(within(choice).getByRole("radio", { name: "Taller than" }))

    expect({
      never: within(choice).getByRole("radio", { name: "Never" }).getAttribute("data-state"),
      preview: screen.queryByTestId("fold-preview"),
    }).toEqual({ never: "checked", preview: null })
    expect(updatePreference).toHaveBeenCalledWith("boardCardCollapseEnabled", true)
  })

  it("picks Taller than in the same write as a valid fold height typed under Never", () => {
    const { updatePreference, updatePreferences } = mount({
      boardCardCollapseEnabled: false,
      boardCardCollapseAtHeight: 450,
      boardCardCollapseToHeight: 300,
    })
    const at = screen.getByRole("spinbutton", { name: settingDef("board-card-collapse-at").label })
    fireEvent.change(at, { target: { value: "500" } })
    fireEvent.blur(at)

    expect({ picked: updatePreference.mock.calls, heights: updatePreferences.mock.calls }).toEqual({
      picked: [],
      heights: [[{ boardCardCollapseEnabled: true, boardCardCollapseAtHeight: 500, boardCardCollapseToHeight: 300 }]],
    })
  })

  it("previews a collapsed card that grows with the collapsed height as it's typed", () => {
    mount({ boardCardCollapseEnabled: true, boardCardCollapseAtHeight: 900, boardCardCollapseToHeight: 240 })
    const to = screen.getByRole("spinbutton", { name: settingDef("board-card-collapse-to").label })
    const height = () => screen.getByTestId("fold-preview-text").style.height
    const before = height()
    fireEvent.change(to, { target: { value: "480" } })

    expect({ before, after: height() }).toEqual({ before: "120px", after: "240px" })
  })
})
