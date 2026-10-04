import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { VisibilityPicker } from "./visibility-picker"

describe("VisibilityPicker", () => {
  it("should offer Public, Open to guests and Private in order when rendered", () => {
    render(<VisibilityPicker value="public" onChange={() => {}} />)
    const names = screen.getAllByRole("button").map((button) => button.textContent)
    expect(names).toEqual([
      expect.stringMatching(/^Public/),
      expect.stringMatching(/^Open to guests/),
      expect.stringMatching(/^Private/),
    ])
  })

  it("should emit guest_public when Open to guests is chosen", async () => {
    const onChange = vi.fn()
    render(<VisibilityPicker value="public" onChange={onChange} />)
    await userEvent.click(screen.getByRole("button", { name: /Open to guests/ }))
    expect(onChange).toHaveBeenCalledWith("guest_public")
  })
})
