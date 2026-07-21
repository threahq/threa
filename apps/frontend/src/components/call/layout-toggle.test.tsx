import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, userEvent } from "@/test"
import { getCallPrefs, setCallLayout, __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import { LayoutToggle } from "./layout-toggle"

beforeEach(() => {
  localStorage.clear()
  __resetCallPrefsForTests()
})

describe("LayoutToggle", () => {
  it("renders both options and reflects the current layout", () => {
    render(<LayoutToggle />)

    const speaker = screen.getByRole("radio", { name: "Speaker" })
    const grid = screen.getByRole("radio", { name: "Grid" })

    expect(speaker).toHaveAttribute("aria-checked", "true")
    expect(grid).toHaveAttribute("aria-checked", "false")
  })

  it("reflects a non-default layout", () => {
    setCallLayout("grid")
    render(<LayoutToggle />)

    expect(screen.getByRole("radio", { name: "Grid" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radio", { name: "Speaker" })).toHaveAttribute("aria-checked", "false")
  })

  it("writes the layout via setCallLayout on click", async () => {
    render(<LayoutToggle />)

    await userEvent.click(screen.getByRole("radio", { name: "Grid" }))

    expect(getCallPrefs().layout).toBe("grid")
    expect(screen.getByRole("radio", { name: "Grid" })).toHaveAttribute("aria-checked", "true")
  })
})
