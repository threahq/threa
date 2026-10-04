import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { VisibilityPicker } from "./visibility-picker"

describe("VisibilityPicker", () => {
  it("should offer Public, Open to guests and Private in order when rendered", () => {
    render(<VisibilityPicker value="public" onChange={() => {}} />)
    const labels = screen.getAllByRole("button").map((b) => b.querySelector("span")?.textContent)
    expect(labels).toEqual(["Public", "Open to guests", "Private"])
  })

  it("should emit guest_public when Open to guests is chosen", async () => {
    const onChange = vi.fn()
    render(<VisibilityPicker value="public" onChange={onChange} />)
    await userEvent.click(screen.getByRole("button", { name: /Open to guests/ }))
    expect(onChange).toHaveBeenCalledWith("guest_public")
  })
})
