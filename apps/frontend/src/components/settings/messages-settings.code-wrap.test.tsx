import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CodeBlockWrap } from "@threahq/types"
import { MessagesSettings } from "./messages-settings"
import * as contextsModule from "@/contexts"

function mount(prefs: { codeBlockWrap?: CodeBlockWrap; codeBlockWrapOverrides?: Record<string, CodeBlockWrap> }) {
  const updatePreference = vi.fn()
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { ...prefs, accessibility: {} },
    updatePreference,
    updatePreferences: vi.fn(),
    isLoading: false,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  render(<MessagesSettings />)
  return { updatePreference }
}

async function openLanguages() {
  await userEvent.click(screen.getByRole("button", { name: /Per language/ }))
}

describe("MessagesSettings — code block wrapping", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it("should default to scrolling and write the wrap choice", async () => {
    const { updatePreference } = mount({})
    const group = within(screen.getByRole("radiogroup", { name: "Long lines" }))
    expect(group.getByRole("radio", { name: "Scroll" })).toHaveAttribute("data-state", "checked")
    await userEvent.click(group.getByRole("radio", { name: "Wrap" }))
    expect(updatePreference).toHaveBeenCalledWith("codeBlockWrap", "wrap")
  })

  it("should list overrides by language label and remove one", async () => {
    const { updatePreference } = mount({
      codeBlockWrap: "wrap",
      codeBlockWrapOverrides: { sql: "scroll", python: "scroll" },
    })
    expect(screen.getByRole("button", { name: /Per language/ })).toHaveTextContent("Own setting for Python, SQL")
    await openLanguages()
    expect(screen.getByText("Python")).toBeInTheDocument()
    expect(screen.getByText("SQL")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Remove SQL override" }))
    expect(updatePreference).toHaveBeenCalledWith("codeBlockWrapOverrides", { python: "scroll" })
  })

  it("should move focus to the override left, then to the add field, as overrides are removed", async () => {
    const user = userEvent.setup()
    let overrides: Record<string, CodeBlockWrap> = { sql: "scroll", python: "scroll" }
    const updatePreference = vi.fn((_key: string, next: Record<string, CodeBlockWrap>) => {
      overrides = next
      rerender(<MessagesSettings />)
    })
    vi.spyOn(contextsModule, "usePreferences").mockImplementation(
      () =>
        ({
          preferences: { codeBlockWrap: "wrap", codeBlockWrapOverrides: overrides, accessibility: {} },
          updatePreference,
          updatePreferences: vi.fn(),
          isLoading: false,
        }) as unknown as ReturnType<typeof contextsModule.usePreferences>
    )
    const { rerender } = render(<MessagesSettings />)
    await openLanguages()

    await user.click(screen.getByRole("button", { name: "Remove SQL override" }))
    const afterFirst = document.activeElement?.getAttribute("aria-label")
    await user.click(screen.getByRole("button", { name: "Remove Python override" }))

    expect({ afterFirst, afterLast: document.activeElement?.getAttribute("aria-label") }).toEqual({
      afterFirst: "Remove Python override",
      afterLast: "Add a language",
    })
  })

  it("should add a language with the mode opposite to the global choice", async () => {
    const user = userEvent.setup()
    const { updatePreference } = mount({ codeBlockWrap: "scroll", codeBlockWrapOverrides: { sql: "wrap" } })
    await openLanguages()
    await user.click(screen.getByRole("combobox", { name: "Add a language" }))
    expect(screen.queryByRole("option", { name: "SQL" })).not.toBeInTheDocument()
    await user.click(await screen.findByRole("option", { name: "Python" }))
    expect(updatePreference).toHaveBeenCalledWith("codeBlockWrapOverrides", { sql: "wrap", python: "wrap" })
  })

  it("should rewrite one override's mode in place", async () => {
    const user = userEvent.setup()
    const { updatePreference } = mount({ codeBlockWrap: "scroll", codeBlockWrapOverrides: { sql: "wrap" } })
    await openLanguages()
    await user.click(screen.getByRole("combobox", { name: "Long lines in SQL" }))
    await user.click(await screen.findByRole("option", { name: "Scroll" }))
    expect(updatePreference).toHaveBeenCalledWith("codeBlockWrapOverrides", { sql: "scroll" })
  })
})
