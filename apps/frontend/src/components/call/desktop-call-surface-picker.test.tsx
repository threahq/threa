import { describe, expect, it, vi } from "vitest"
import { render, screen, userEvent } from "@/test"
import { DesktopCallSurfacePicker } from "./desktop-call-surface-picker"

describe("DesktopCallSurfacePicker", () => {
  it("shows the selected surface and selects every peer surface by keyboard", async () => {
    const onValueChange = vi.fn()
    render(<DesktopCallSurfacePicker value="sidebar" onValueChange={onValueChange} />)
    const trigger = screen.getByLabelText("Call surface")
    expect(trigger).toHaveTextContent("Sidebar")

    trigger.focus()
    await userEvent.keyboard("{Enter}")
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Floating" }))
    expect(onValueChange).toHaveBeenCalledWith("floating")

    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Sidebar" }))
    expect(onValueChange).toHaveBeenCalledWith("sidebar")

    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Fullscreen" }))
    expect(onValueChange).toHaveBeenCalledWith("fullscreen")
  })
})
