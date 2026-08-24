import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AsideDraftStrip } from "./aside-draft-strip"
import type { AsideDraftRow } from "./use-aside-drafts"

const drafts: AsideDraftRow[] = [
  {
    id: "draft_1",
    scope: "aside:stream_a:draft_1",
    preview: "Worth a caveat before Thursday",
    clientUpdatedAt: Date.now() - 9 * 60_000,
    isEmpty: false,
  },
  {
    id: "draft_2",
    scope: "aside:stream_a:draft_2",
    preview: "",
    clientUpdatedAt: Date.now() - 60 * 60_000,
    isEmpty: true,
  },
]

describe("AsideDraftStrip", () => {
  it("names every draft with its age, the way the attachment tray names files", () => {
    render(
      <AsideDraftStrip
        drafts={drafts}
        openScope="aside:stream_a:draft_2"
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(screen.getByRole("button", { name: "Open draft: Worth a caveat before Thursday" })).toHaveTextContent("9m")
    expect(screen.getByRole("button", { name: "Open draft: Empty draft" })).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("button", { name: "Open draft: Worth a caveat before Thursday" })).not.toHaveAttribute(
      "aria-current"
    )
  })

  it("opens a draft from its pill, throws one away from its ×, and starts a new one", () => {
    const onOpen = vi.fn()
    const onNew = vi.fn()
    const onDelete = vi.fn()
    render(<AsideDraftStrip drafts={drafts} openScope={null} onOpen={onOpen} onNew={onNew} onDelete={onDelete} />)

    fireEvent.click(screen.getByRole("button", { name: "Open draft: Worth a caveat before Thursday" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete draft: Empty draft" }))
    fireEvent.click(screen.getByRole("button", { name: "New draft" }))

    expect({ opened: onOpen.mock.calls, deleted: onDelete.mock.calls, created: onNew.mock.calls }).toEqual({
      opened: [["aside:stream_a:draft_1"]],
      deleted: [["aside:stream_a:draft_2"]],
      created: [[]],
    })
  })

  it("says what the button is for while there is nothing in the tray", () => {
    render(<AsideDraftStrip drafts={[]} openScope={null} onOpen={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} />)

    // The accessible name is the visible one, so "click Start a draft" works
    // for speech input (WCAG 2.5.3).
    expect(screen.getByRole("button", { name: "Start a draft" })).toHaveTextContent("Start a draft")
  })
})
