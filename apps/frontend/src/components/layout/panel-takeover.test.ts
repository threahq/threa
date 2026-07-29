import { describe, it, expect } from "vitest"
import { panelTakeoverClasses } from "./panel-takeover"

describe("panelTakeoverClasses", () => {
  it("hides the main column with visibility, never display", () => {
    const { main } = panelTakeoverClasses(true)
    expect(main).toContain("invisible")
    // Tailwind's `hidden` is `display: none`, which destroys the scroller's box
    // and its offset — the whole point of the takeover is that both survive.
    expect(main.split(" ")).not.toContain("hidden")
  })

  it("makes the hidden column inert, and drops the attribute when it isn't", () => {
    expect(panelTakeoverClasses(true).mainInert).toBe(true)
    expect(panelTakeoverClasses(false).mainInert).toBeUndefined()
  })

  it("lays the column out beside the panel when there is no takeover", () => {
    const { container, main } = panelTakeoverClasses(false)
    expect(container).toContain("flex")
    expect(main).toContain("flex-1")
    expect(main).not.toContain("invisible")
  })
})
