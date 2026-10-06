import { describe, it, expect } from "vitest"
import {
  NO_PANELS,
  activatePanelTab,
  closePanelTab,
  fitPanelLayout,
  focusPanelTab,
  followCurrentPanel,
  formatPanelLayout,
  openPanelTab,
  openPanelTabBeside,
  openPanelTabWith,
  parsePanelLayout,
  primaryPanelOf,
  replacePanelTab,
  splitPanelTab,
  type PanelLayout,
} from "./panel-tabs"

const at = parsePanelLayout
const spell = (layout: PanelLayout) => formatPanelLayout(layout)

describe("parsePanelLayout", () => {
  it("should read a single panel id as one active tab when the URL predates tabs", () => {
    expect(at("stream_a")).toEqual({ columns: [[{ ids: ["stream_a"], active: "stream_a" }]] })
  })

  it("should make the last tab of each section active when none is marked", () => {
    expect(at("stream_a.stream_b")).toEqual({ columns: [[{ ids: ["stream_a", "stream_b"], active: "stream_b" }]] })
  })

  it("should make the marked tab active when one is marked", () => {
    expect(at("stream_a*.conv:conv_b")).toEqual({
      columns: [[{ ids: ["stream_a", "conv:conv_b"], active: "stream_a" }]],
    })
  })

  it("should read sections side by side and stacked when the value has splits", () => {
    expect(at("a*.b-c--d.e")).toEqual({
      columns: [
        [{ ids: ["a", "b"], active: "a" }],
        [
          { ids: ["c"], active: "c" },
          { ids: ["d", "e"], active: "e" },
        ],
      ],
    })
  })

  it("should keep draft ids whole when they carry colons", () => {
    expect(at("draft:stream_p:msg_1.stream_b")).toEqual({
      columns: [[{ ids: ["draft:stream_p:msg_1", "stream_b"], active: "stream_b" }]],
    })
  })

  it("should drop empty sections and ids open twice when the value was hand-edited", () => {
    expect(spell(at("--.a..a*.b.-a-c-"))).toBe("a.b-c")
  })

  it("should keep the next column beside when the section stacked before it was dropped", () => {
    expect([spell(at("a--a-b")), spell(at("a--*-b"))]).toEqual(["a-b", "a-b"])
  })

  it("should read no panels when the param is missing or empty", () => {
    expect([at(null), at(""), at("*"), at("-.--")]).toEqual([NO_PANELS, NO_PANELS, NO_PANELS, NO_PANELS])
  })
})

describe("formatPanelLayout", () => {
  it("should write one spelling per arrangement when it round-trips", () => {
    const values = ["stream_a", "a.b", "a*.b", "a.b*.c", "a-b", "a*.b-c--d", "a--b-c*.d"]
    expect(values.map((value) => spell(at(value)))).toEqual(values)
  })

  it("should write nothing when no panel is open", () => {
    expect(spell(NO_PANELS)).toBeNull()
  })
})

describe("opening", () => {
  it("should add a tab to the first section when the main view opens it", () => {
    expect(spell(openPanelTab(at("a.b*.c-d"), "x"))).toBe("a.b.c.x-d")
  })

  it("should open a first section when nothing is open", () => {
    expect(spell(openPanelTab(NO_PANELS, "x"))).toBe("x")
  })

  it("should activate a tab where it is when it is already open", () => {
    expect(spell(openPanelTab(at("a-b.c"), "b"))).toBe("a-b*.c")
  })

  it("should split a column off to the right when a tab opens beside one in the last column", () => {
    expect(spell(openPanelTabBeside(at("a.b"), "b", "x"))).toBe("a.b-x")
  })

  it("should add to the top section of the next column when one is there", () => {
    expect(spell(openPanelTabBeside(at("a-b--c"), "a", "x"))).toBe("a-b.x--c")
  })

  it("should activate rather than move a tab opened beside when it is already open", () => {
    expect(spell(openPanelTabBeside(at("a.b-c"), "c", "a"))).toBe("a*.b-c")
  })

  it("should fall back to the first section when the opener is no longer open", () => {
    expect(spell(openPanelTabBeside(at("a"), "gone", "x"))).toBe("a.x")
  })

  it("should add a tab to the section holding the given tab when it is open", () => {
    expect(spell(openPanelTabWith(at("a-b*.c--d"), "c", "x"))).toBe("a-b.c.x--d")
  })

  it("should fall back to the first section when the given tab is not open", () => {
    expect(spell(openPanelTabWith(at("a-b"), null, "x"))).toBe("a.x-b")
    expect(spell(openPanelTabWith(NO_PANELS, "gone", "x"))).toBe("x")
  })
})

describe("activating and closing", () => {
  const layout = at("a.b*.c")

  it("should leave the layout alone when activating a tab that isn't open", () => {
    expect(activatePanelTab(layout, "z")).toBe(layout)
  })

  it("should hand the section to the tab that slides into place when the active tab closes", () => {
    expect(spell(closePanelTab(layout, "b"))).toBe("a.c")
  })

  it("should hand the section to the new last tab when the active last tab closes", () => {
    expect(spell(closePanelTab(at("a.b"), "b"))).toBe("a")
  })

  it("should keep the active tab when another tab closes", () => {
    expect(spell(closePanelTab(layout, "a"))).toBe("b*.c")
  })

  it("should close the section and its emptied column when its last tab closes", () => {
    expect([spell(closePanelTab(at("a-b-c"), "b")), spell(closePanelTab(at("a-b--c"), "b"))]).toEqual(["a-c", "a-c"])
  })

  it("should leave no panels when the only one closes", () => {
    expect(closePanelTab(at("a"), "a")).toEqual(NO_PANELS)
  })
})

describe("replacePanelTab", () => {
  const layout = at("a.b*.c-d")

  it("should swap a tab in place when it navigates somewhere new", () => {
    expect(spell(replacePanelTab(layout, "b", "x"))).toBe("a.x*.c-d")
  })

  it("should keep an inactive tab inactive when it is replaced", () => {
    expect(spell(replacePanelTab(layout, "a", "x"))).toBe("x.b*.c-d")
  })

  it("should move the target into the navigating tab's place when it is open in another section", () => {
    expect(spell(replacePanelTab(layout, "b", "d"))).toBe("a.d*.c")
  })

  it("should close the navigating tab and show the target when the target is a tab beside it", () => {
    expect([spell(replacePanelTab(layout, "b", "c")), spell(replacePanelTab(at("a.b.c"), "b", "c"))]).toEqual([
      "a.c-d",
      "a.c",
    ])
  })

  it("should open the target as a new tab when the navigating tab is already gone", () => {
    expect(replacePanelTab(layout, "gone", "x")).toEqual(openPanelTab(layout, "x"))
  })
})

describe("focusPanelTab", () => {
  it("should mark the focused tab wherever it sits and read it back focused and active", () => {
    const values = ["a**", "a**.b", "a.b**-c", "a-b--c.d**"]
    expect([values.map((value) => spell(at(value))), at("a**.b")]).toEqual([
      values,
      { columns: [[{ ids: ["a", "b"], active: "a" }]], focused: "a" },
    ])
  })

  it("should bring a tab to the front of its section when it is focused", () => {
    expect([spell(focusPanelTab(at("a.b-c"), "a")), spell(focusPanelTab(at("a**.b-c"), null))]).toEqual([
      "a**.b-c",
      "a*.b-c",
    ])
  })

  it("should leave the layout alone when focusing a tab that isn't open", () => {
    const layout = at("a.b")
    expect(focusPanelTab(layout, "z")).toBe(layout)
  })

  it("should leave the layout alone when putting back with nothing focused", () => {
    const layout = at("a.b")
    expect(focusPanelTab(layout, null)).toBe(layout)
  })

  it("should read the first focus mark only when a hand-edited value has two", () => {
    expect(spell(at("a**-b**.c"))).toBe("a**-b*.c")
  })

  it("should put the focused tab back when another tab is brought forward or opened", () => {
    const layout = at("a.b**-c")
    expect([
      spell(activatePanelTab(layout, "a")),
      spell(activatePanelTab(layout, "c")),
      spell(activatePanelTab(layout, "b")),
      spell(openPanelTabBeside(layout, "b", "x")),
      spell(splitPanelTab(layout, "a", "down")),
    ]).toEqual(["a*.b-c", "a.b-c", "a.b**-c", "a.b-c.x", "b--a-c"])
  })

  it("should keep the focused tab floating when another tab closes or a draft swaps out", () => {
    const layout = at("a.b**-c")
    expect([
      spell(closePanelTab(layout, "a")),
      spell(closePanelTab(layout, "c")),
      spell(closePanelTab(layout, "b")),
      spell(replacePanelTab(layout, "b", "x")),
      spell(replacePanelTab(layout, "c", "x")),
    ]).toEqual(["b**-c", "a.b**", "a-c", "a.x**-c", "a.b**-x"])
  })

  it("should keep a floating tab floating when a background tab navigates to it", () => {
    expect(spell(replacePanelTab(at("a.b-c**"), "a", "c"))).toBe("c**.b")
  })
})

describe("splitPanelTab", () => {
  it("should move a tab into a new column to the right of its own", () => {
    expect(spell(splitPanelTab(at("a.b*.c-d"), "b", "right"))).toBe("a.c-b-d")
  })

  it("should move a tab into a new section under its own", () => {
    expect(spell(splitPanelTab(at("a.b--c"), "a", "down"))).toBe("b--a--c")
  })

  it("should leave a section's only tab where it is", () => {
    const layout = at("a-b")
    expect(splitPanelTab(layout, "b", "right")).toBe(layout)
  })
})

describe("fitPanelLayout", () => {
  const layout = at("a-b.c*--d-e")

  it("should keep the arrangement when every column fits", () => {
    expect(fitPanelLayout(layout, 3, false, null)).toBe(layout)
  })

  it("should fold the columns that don't fit into one section showing the last one's tab", () => {
    expect(spell(fitPanelLayout(layout, 2, false, null))).toBe("a-b.c.d.e")
  })

  it("should show the current pane when it is on show in a folded section", () => {
    expect(spell(fitPanelLayout(layout, 2, false, "c"))).toBe("a-b.c*.d.e")
  })

  it("should show the last folded section's tab when the current pane is covered in its own", () => {
    expect(spell(fitPanelLayout(layout, 2, false, "b"))).toBe("a-b.c.d.e")
  })

  it("should fold everything into one section when stacked", () => {
    expect(spell(fitPanelLayout(layout, 3, true, null))).toBe("a.b.c.d.e")
  })

  it("should keep a single section as it is when stacked", () => {
    const single = at("a*.b")
    expect(fitPanelLayout(single, 1, true, "b")).toBe(single)
  })
})

describe("primaryPanelOf", () => {
  it("should name the tab on show in the first section", () => {
    expect([primaryPanelOf(at("a*.b-c")), primaryPanelOf(NO_PANELS)]).toEqual(["a", null])
  })
})

describe("followCurrentPanel", () => {
  it("should make a tab just opened current", () => {
    expect(followCurrentPanel(at("a"), at("a-x"), "a")).toBe("x")
  })

  it("should keep the current pane while it stays on show", () => {
    expect(followCurrentPanel(at("a-b.c"), at("a-b*.c"), "a")).toBe("a")
  })

  it("should hand current to the tab now on show in its section when it is covered or closed", () => {
    expect([
      followCurrentPanel(at("a.b-c"), at("a*.b-c"), "b"),
      followCurrentPanel(at("a.b-c"), at("a-c"), "b"),
    ]).toEqual(["a", "a"])
  })

  it("should hand current to the section before its own when its whole section closed", () => {
    expect([
      followCurrentPanel(at("a-b"), at("a"), "b"),
      followCurrentPanel(at("a-b--c-d"), at("a-b-d"), "c"),
      followCurrentPanel(at("a-b"), at("b"), "a"),
    ]).toEqual(["a", "b", "b"])
  })

  it("should stay on the main view when no tab opened", () => {
    expect(followCurrentPanel(at("a-b"), at("a"), null)).toBeNull()
  })

  it("should not treat a tab swapped in place as an opening", () => {
    const prev = at("a-draft")
    const promoted = replacePanelTab(prev, "draft", "x")
    expect([
      followCurrentPanel(prev, promoted, "a"),
      followCurrentPanel(prev, promoted, null),
      followCurrentPanel(prev, promoted, "draft"),
    ]).toEqual(["a", null, "x"])
  })

  it("should follow a tab that navigated to one open in another section", () => {
    const prev = at("a.b*.c-d")
    expect(followCurrentPanel(prev, replacePanelTab(prev, "b", "d"), "b")).toBe("d")
  })
})
