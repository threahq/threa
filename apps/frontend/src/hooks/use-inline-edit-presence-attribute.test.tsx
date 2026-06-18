import { describe, it, expect, afterEach } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { useInlineEditPresenceAttribute } from "./use-inline-edit-presence-attribute"

function Harness() {
  useInlineEditPresenceAttribute()
  return null
}

describe("useInlineEditPresenceAttribute", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    document.body.removeAttribute("data-inline-edit-active")
  })

  it("mirrors inline edit presence onto the body", async () => {
    const { unmount } = render(<Harness />)

    expect(document.body).not.toHaveAttribute("data-inline-edit-active")

    const edit = document.createElement("div")
    edit.setAttribute("data-inline-edit", "")
    document.body.append(edit)

    await waitFor(() => expect(document.body).toHaveAttribute("data-inline-edit-active"))

    edit.remove()

    await waitFor(() => expect(document.body).not.toHaveAttribute("data-inline-edit-active"))

    unmount()
    expect(document.body).not.toHaveAttribute("data-inline-edit-active")
  })

  it("tracks nested and attribute-created edit surfaces", async () => {
    render(<Harness />)

    const wrapper = document.createElement("div")
    wrapper.innerHTML = `<section><div data-inline-edit></div></section>`
    document.body.append(wrapper)

    await waitFor(() => expect(document.body).toHaveAttribute("data-inline-edit-active"))

    wrapper.innerHTML = ""

    await waitFor(() => expect(document.body).not.toHaveAttribute("data-inline-edit-active"))

    const late = document.createElement("div")
    document.body.append(late)
    late.setAttribute("data-inline-edit", "")

    await waitFor(() => expect(document.body).toHaveAttribute("data-inline-edit-active"))

    late.removeAttribute("data-inline-edit")

    await waitFor(() => expect(document.body).not.toHaveAttribute("data-inline-edit-active"))
  })

  it("keeps the body active when an attribute-created edit replaces an existing edit in one batch", async () => {
    render(<Harness />)

    const existing = document.createElement("div")
    existing.setAttribute("data-inline-edit", "")
    document.body.append(existing)

    await waitFor(() => expect(document.body).toHaveAttribute("data-inline-edit-active"))

    const replacement = document.createElement("div")
    document.body.append(replacement)
    replacement.setAttribute("data-inline-edit", "")
    existing.remove()

    await waitFor(() => expect(document.body).toHaveAttribute("data-inline-edit-active"))
  })
})
