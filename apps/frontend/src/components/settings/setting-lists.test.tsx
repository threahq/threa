import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SettingCheckboxList, SettingOverrideList } from "./setting-lists"

describe("SettingCheckboxList", () => {
  it("toggles an item from its label, and keeps an item with a reason unpickable and described by it", async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(
      <>
        <span id="tools-label">Tools</span>
        <SettingCheckboxList
          aria-labelledby="tools-label"
          items={[
            { value: "web", label: "Web", description: "Search and read pages." },
            { value: "code", label: "Code", reason: "Coming soon." },
          ]}
          selected={["code"]}
          onCheckedChange={onCheckedChange}
        />
      </>
    )
    await user.click(screen.getByText("Search and read pages."))
    const code = screen.getByRole("checkbox", { name: "Code" })

    expect({
      toggled: onCheckedChange.mock.calls,
      group: screen.getByRole("group", { name: "Tools" }) !== null,
      codeDisabled: (code as HTMLButtonElement).disabled,
      codeChecked: code.getAttribute("data-state"),
    }).toEqual({ toggled: [["web", true]], group: true, codeDisabled: true, codeChecked: "checked" })
    expect(code).toHaveAccessibleDescription("Coming soon.")
  })
})

describe("SettingOverrideList", () => {
  const options = [
    { value: "wrap", label: "Wrap" },
    { value: "scroll", label: "Scroll" },
  ] as const

  it("names each item's select and remove button, and hides the add select once nothing is left to add", async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(
      <>
        <span id="langs">Per language</span>
        <SettingOverrideList
          aria-labelledby="langs"
          options={options}
          selectLabel={(label) => `Long lines in ${label}`}
          removeLabel={(label) => `Remove ${label} override`}
          items={[{ key: "py", label: "Python", value: "wrap", onValueChange: vi.fn(), onRemove }]}
          add={{ label: "Add a language", options: [], onAdd: vi.fn() }}
        />
      </>
    )
    await user.click(screen.getByRole("button", { name: "Remove Python override" }))

    expect({
      select: screen.getByRole("combobox", { name: "Long lines in Python" }).textContent,
      removed: onRemove.mock.calls.length,
      add: screen.queryByRole("combobox", { name: "Add a language" }),
    }).toEqual({ select: "Wrap", removed: 1, add: null })
  })
})
