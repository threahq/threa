import { describe, expect, it } from "vitest"
import { foldHeaderControls, PANE_TITLE_MIN_WIDTH } from "./pane-header-fold"

const controls = [
  { id: "aside", width: 40 },
  { id: "context", width: 36 },
  { id: "search", width: 36 },
] as const

describe("foldHeaderControls", () => {
  it("should fold nothing while the header is unmeasured", () => {
    expect([...foldHeaderControls(0, 100, [...controls])]).toEqual([])
  })

  it("should fold nothing when everything fits beside the title's minimum", () => {
    expect([...foldHeaderControls(100 + PANE_TITLE_MIN_WIDTH + 112, 100, [...controls])]).toEqual([])
  })

  it("should fold in the given order until the title keeps its minimum", () => {
    expect([...foldHeaderControls(100 + PANE_TITLE_MIN_WIDTH + 72, 100, [...controls])]).toEqual(["aside"])
    expect([...foldHeaderControls(100 + PANE_TITLE_MIN_WIDTH + 71, 100, [...controls])]).toEqual(["aside", "context"])
    expect([...foldHeaderControls(150, 100, [...controls])]).toEqual(["aside", "context", "search"])
  })
})
