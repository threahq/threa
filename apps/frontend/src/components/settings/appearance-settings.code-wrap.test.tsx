import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { CodeBlockWrap } from "@threa/types"
import { AppearanceSettings } from "./appearance-settings"
import * as contextsModule from "@/contexts"
import * as boardViewsModule from "@/hooks/use-board-views"

const WS = "ws_1"

function mount(prefs: { codeBlockWrap?: CodeBlockWrap; codeBlockWrapOverrides?: Record<string, CodeBlockWrap> }) {
  const updatePreference = vi.fn()
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { ...prefs, accessibility: {} },
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

describe("AppearanceSettings — code block wrapping", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("should default to scrolling and write the wrap choice", async () => {
    const { updatePreference } = mount({})
    expect(document.getElementById("code-block-wrap-scroll")).toHaveAttribute("data-state", "checked")
    await userEvent.click(screen.getByLabelText("Wrap lines"))
    expect(updatePreference).toHaveBeenCalledWith("codeBlockWrap", "wrap")
  })

  it("should list overrides by language label and remove one", async () => {
    const { updatePreference } = mount({
      codeBlockWrap: "wrap",
      codeBlockWrapOverrides: { sql: "scroll", python: "scroll" },
    })
    expect(screen.getByText("Python")).toBeInTheDocument()
    expect(screen.getByText("SQL")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Remove SQL override" }))
    expect(updatePreference).toHaveBeenCalledWith("codeBlockWrapOverrides", { python: "scroll" })
  })

  it("should add a language with the mode opposite to the global choice", async () => {
    const user = userEvent.setup()
    const { updatePreference } = mount({ codeBlockWrap: "scroll", codeBlockWrapOverrides: { sql: "wrap" } })
    await user.click(screen.getByRole("combobox", { name: "Per language" }))
    expect(screen.queryByRole("option", { name: "SQL" })).not.toBeInTheDocument()
    await user.click(await screen.findByRole("option", { name: "Python" }))
    expect(updatePreference).toHaveBeenCalledWith("codeBlockWrapOverrides", { sql: "wrap", python: "wrap" })
  })

  it("should rewrite one override's mode in place", async () => {
    const user = userEvent.setup()
    const { updatePreference } = mount({ codeBlockWrap: "scroll", codeBlockWrapOverrides: { sql: "wrap" } })
    await user.click(screen.getByRole("combobox", { name: "Long lines in SQL" }))
    await user.click(await screen.findByRole("option", { name: "Scroll horizontally" }))
    expect(updatePreference).toHaveBeenCalledWith("codeBlockWrapOverrides", { sql: "scroll" })
  })
})
