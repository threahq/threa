import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AsideDraftTabs } from "./aside-draft-tabs"
import type { AsideDraftRow } from "./use-aside-drafts"

const drafts: AsideDraftRow[] = [
  {
    id: "draft_1",
    scope: "aside:stream_a:draft_1",
    preview: "Worth a caveat before Thursday",
    clientUpdatedAt: 2,
    isEmpty: false,
  },
  { id: "draft_2", scope: "aside:stream_a:draft_2", preview: "", clientUpdatedAt: 1, isEmpty: true },
]

describe("AsideDraftTabs", () => {
  it("names every draft in one strip and marks the one being written", () => {
    render(<AsideDraftTabs drafts={drafts} openScope="aside:stream_a:draft_2" onOpen={vi.fn()} onNew={vi.fn()} />)

    expect(screen.getAllByRole("tab").map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
      ["Worth a caveat before Thursday", "false"],
      ["Empty draft", "true"],
    ])
  })

  it("opens the draft on its own tab, and starts a new one from the same strip", () => {
    const onOpen = vi.fn()
    const onNew = vi.fn()
    render(<AsideDraftTabs drafts={drafts} openScope={null} onOpen={onOpen} onNew={onNew} />)

    fireEvent.click(screen.getByRole("tab", { name: "Worth a caveat before Thursday" }))
    fireEvent.click(screen.getByRole("button", { name: "New draft" }))

    expect(onOpen).toHaveBeenCalledWith("aside:stream_a:draft_1")
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it("says what the button is for while there is nothing to switch between", () => {
    render(<AsideDraftTabs drafts={[]} openScope={null} onOpen={vi.fn()} onNew={vi.fn()} />)

    expect(screen.queryByRole("tablist")).toBeNull()
    expect(screen.getByRole("button", { name: "New draft" })).toHaveTextContent("Start a draft")
  })
})
