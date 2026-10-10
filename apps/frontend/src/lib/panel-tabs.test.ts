import { describe, it, expect } from "vitest"
import { NON_SERVER_STREAM_ID_PREFIXES } from "./stream-ids"
import {
  ACTIVE_MARK,
  NO_PANELS,
  SECTION_SEPARATOR,
  TAB_SEPARATOR,
  activatePanelTab,
  canonicalPanelLayout,
  closePanelTab,
  dropPanelTab,
  fitPanelLayout,
  fitPanelRows,
  focusPanelTab,
  followCurrentPanel,
  formatPanelLayout,
  fullPanelLayout,
  openPanelTab,
  openPanelTabBeside,
  openPanelTabWith,
  parsePanelLayout,
  primaryPanelOf,
  replacePanelTab,
  splitPanelTab,
  streamPaneAfter,
  tabsBeside,
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

  it("should drop a route's page when the value names one, since only its route places it", () => {
    expect([spell(at("page:board.stream_x")), spell(at("page:board-stream_x")), at("page:board")]).toEqual([
      "stream_x",
      "stream_x",
      NO_PANELS,
    ])
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

  it("should keep a persona test-chat id whole when it sits beside other panes", () => {
    const value = "test:persona_x.stream_a-test:persona_y"
    expect({ layout: at(value), spelled: spell(at(value)) }).toEqual({
      layout: {
        columns: [
          [{ ids: ["test:persona_x", "stream_a"], active: "stream_a" }],
          [{ ids: ["test:persona_y"], active: "test:persona_y" }],
        ],
      },
      spelled: value,
    })
  })

  it("should keep every pane prefix free of the panel grammar characters", () => {
    const grammar = [TAB_SEPARATOR, ACTIVE_MARK, SECTION_SEPARATOR]
    expect(NON_SERVER_STREAM_ID_PREFIXES.filter((prefix) => grammar.some((char) => prefix.includes(char)))).toEqual([])
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
      { columns: [[{ ids: ["a", "b"], active: "a" }]], focused: ["a"] },
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

  it("should read every section's focus mark as one group, and only the first in a section", () => {
    expect([at("a**-b**.c").focused, spell(at("a**-b**.c")), spell(at("a**.b**"))]).toEqual([
      ["a", "b"],
      "a**-b**.c",
      "a**.b",
    ])
  })

  it("should float the tab brought forward in the floating section, and put it back for one elsewhere or opened", () => {
    const layout = at("a.b**-c")
    expect([
      spell(activatePanelTab(layout, "a")),
      spell(activatePanelTab(layout, "c")),
      spell(activatePanelTab(layout, "b")),
      spell(splitPanelTab(layout, "a", "down")),
    ]).toEqual(["a**.b-c", "a.b-c", "a.b**-c", "b--a-c"])
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

describe("focus group", () => {
  it("should float a tab opened from inside a floating one where it lands on exit, right of it", () => {
    expect([
      spell(openPanelTabBeside(at("a.b**-c"), "b", "x")),
      spell(openPanelTabBeside(at("a-b**"), "b", "x")),
      spell(openPanelTabBeside(at("a**"), "a", "x")),
    ]).toEqual(["a.b**-c.x**", "a-b**-x**", "a**-x**"])
  })

  it("should give a tab opened in focus a column of its own rather than cover another floating tab", () => {
    expect(spell(openPanelTabBeside(at("a**-b**"), "a", "x"))).toBe("a**-x**-b**")
  })

  it("should float an open tab brought forward from inside the group", () => {
    expect(spell(openPanelTabBeside(at("a**-b.c"), "a", "b"))).toBe("a**-b**.c")
  })

  it("should keep the rest floating when one closes, swaps out, or gives way to a tab in its section", () => {
    const layout = at("a**-c.x**")
    expect([
      spell(closePanelTab(layout, "x")),
      spell(closePanelTab(layout, "a")),
      spell(replacePanelTab(layout, "x", "y")),
      spell(activatePanelTab(layout, "c")),
    ]).toEqual(["a**-c", "c.x**", "a**-c.y**", "a**-c**.x"])
  })

  it("should put the whole group back at once, and float one tab alone when it is focused", () => {
    const layout = at("a**-x**-b")
    expect([spell(focusPanelTab(layout, null)), spell(focusPanelTab(layout, "b")), focusPanelTab(layout, "x")]).toEqual(
      ["a-x-b", "a-x-b**", layout]
    )
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

describe("dropPanelTab", () => {
  it("should add a dropped stream as a tab where it was dropped, on show", () => {
    expect([
      spell(dropPanelTab(at("a-b"), "x", { kind: "tab", of: "b", before: null })),
      spell(dropPanelTab(at("a-b.c"), "x", { kind: "tab", of: "c", before: "b" })),
    ]).toEqual(["a-b.x", "a-x*.b.c"])
  })

  it("should move an open tab rather than open it twice", () => {
    expect([
      spell(dropPanelTab(at("a.b.c"), "c", { kind: "tab", of: "c", before: "a" })),
      spell(dropPanelTab(at("a.b-c"), "b", { kind: "tab", of: "c", before: null })),
      spell(dropPanelTab(at("a-b-c"), "a", { kind: "edge", of: "c", side: "bottom" })),
      spell(dropPanelTab(at("a*.b.c"), "a", { kind: "tab", of: "c", before: null })),
    ]).toEqual(["c*.a.b", "a-c.b", "b-c--a", "b.c.a"])
  })

  it("should start a section of its own on the edge it was dropped on", () => {
    const layout = at("a-b--c")
    expect(
      (["left", "right", "top", "bottom"] as const).map((side) =>
        spell(dropPanelTab(layout, "x", { kind: "edge", of: "b", side }))
      )
    ).toEqual(["a-x-b--c", "a-b--c-x", "a-x--b--c", "a-b--x--c"])
  })

  it("should split a tab off its own section, and leave a section's only tab where it is", () => {
    const lone = at("a-b")
    expect([
      spell(dropPanelTab(at("a.b"), "b", { kind: "edge", of: "b", side: "left" })),
      spell(dropPanelTab(at("a.b"), "a", { kind: "edge", of: "a", side: "bottom" })),
      dropPanelTab(lone, "b", { kind: "edge", of: "b", side: "left" }),
    ]).toEqual(["b-a", "b--a", lone])
  })

  it("should open a first column on the first column's left edge", () => {
    const drop = { kind: "edge", of: "a", side: "left" } as const
    expect([spell(dropPanelTab(at("a-b"), "x", drop)), spell(dropPanelTab(at("a-b"), "b", drop))]).toEqual([
      "x-a-b",
      "b-a",
    ])
  })

  it("should only bring a tab forward when dropped on itself or beside a tab that closed", () => {
    const layout = at("a.b")
    expect([
      spell(dropPanelTab(layout, "a", { kind: "tab", of: "a", before: null })),
      spell(dropPanelTab(layout, "a", { kind: "tab", of: "b", before: "a" })),
      dropPanelTab(layout, "x", { kind: "tab", of: "gone", before: null }),
      dropPanelTab(layout, "x", { kind: "tab", of: "b", before: "gone" }),
    ]).toEqual(["a*.b", "a*.b", layout, layout])
  })

  it("should keep the floating tab floating while it stays on show", () => {
    expect(spell(dropPanelTab(at("a**-b"), "x", { kind: "tab", of: "b", before: null }))).toBe("a**-b.x")
  })
})

describe("fitPanelRows", () => {
  const layout = at("a-b--c*--d")

  it("should keep the arrangement when every section fits down its column", () => {
    expect(fitPanelRows(layout, 3, null)).toBe(layout)
  })

  it("should fold the sections that don't fit into the last one that does, showing the last one's tab", () => {
    expect(spell(fitPanelRows(layout, 2, null))).toBe("a-b--c.d")
  })

  it("should show the current pane when it is on show in a folded section", () => {
    expect(spell(fitPanelRows(layout, 2, "c"))).toBe("a-b--c*.d")
  })

  it("should show the pane last worked in when the current pane is in a section that fits", () => {
    expect(spell(fitPanelRows(layout, 2, "b", "c"))).toBe("a-b--c*.d")
  })

  it("should fold a column into one section where only one fits", () => {
    expect(spell(fitPanelRows(layout, 1, null))).toBe("a-b.c.d")
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

  it("should show the pane last worked in there when the current pane is in a column that fits", () => {
    expect(spell(fitPanelLayout(layout, 2, false, "a", "c"))).toBe("a-b.c*.d.e")
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

  it("should make the newest tab current when no pane was", () => {
    expect([followCurrentPanel(NO_PANELS, NO_PANELS, null), followCurrentPanel(at("a-b"), at("a-b"), null)]).toEqual([
      null,
      "b",
    ])
  })

  it("should not treat a tab swapped in place as an opening", () => {
    const prev = at("a-draft")
    const promoted = replacePanelTab(prev, "draft", "x")
    expect([followCurrentPanel(prev, promoted, "a"), followCurrentPanel(prev, promoted, "draft")]).toEqual(["a", "x"])
  })

  it("should follow a tab that navigated to one open in another section", () => {
    const prev = at("a.b*.c-d")
    expect(followCurrentPanel(prev, replacePanelTab(prev, "b", "d"), "b")).toBe("d")
  })
})

describe("the route's stream pane", () => {
  const page = (path: string, panel: string | null = null) => fullPanelLayout(path, at(panel))
  const query = (layout: PanelLayout, path: string) => spell(canonicalPanelLayout(layout, path))

  it("should put the route's stream in a first column of its own when the panel param doesn't place it", () => {
    expect([
      spell(page("A")),
      spell(page("A", "B")),
      spell(page("A", "B--C.D")),
      spell(page("A", "B**.C")),
      fullPanelLayout(null, at("B")),
    ]).toEqual(["A", "A-B", "A-B--C.D", "A-B**.C", at("B")])
  })

  it("should take the arrangement as written when the panel param places the route's stream", () => {
    expect([spell(page("A", "A.B")), spell(page("B", "A-B")), spell(page("A", "B--A"))]).toEqual(["A.B", "A-B", "B--A"])
  })

  it("should write back the panel param it was read from", () => {
    const urls: [string, string | null][] = [
      ["A", null],
      ["A", "B"],
      ["A", "A.B"],
      ["A", "A*.B"],
      ["A", "B--C.D"],
      ["A", "B**.C"],
      ["A", "A**"],
      ["B", "A-B"],
    ]
    expect(urls.map(([path, panel]) => query(page(path, panel), path))).toEqual(urls.map(([, panel]) => panel))
  })

  it("should move the first column into the panel param when the route names another pane", () => {
    const layout = page("A", "B")
    expect([query(layout, "B"), query(layout, "A")]).toEqual(["A-B", "B"])
  })

  it("should write the route's stream when a phone has it in front and other panes open", () => {
    const layout = page("A", "B.C")
    const alone = page("A")
    expect([
      spell(canonicalPanelLayout(layout, "A", true)),
      spell(canonicalPanelLayout(layout, "A", false)),
      spell(canonicalPanelLayout(alone, "A", true)),
    ]).toEqual(["A-B.C", "B.C", null])
  })

  it("should keep the route's stream while it stays open", () => {
    const prev = page("A", "B.C")
    expect([
      streamPaneAfter(prev, closePanelTab(prev, "C"), "A", "C"),
      streamPaneAfter(prev, activatePanelTab(prev, "B"), "A", "B"),
    ]).toEqual(["A", "A"])
  })

  it("should name the pane current after the route's stream closes when it is a stream", () => {
    const prev = page("A", "B-C")
    expect([
      streamPaneAfter(prev, closePanelTab(prev, "A"), "A", "A"),
      streamPaneAfter(prev, closePanelTab(prev, "A"), "A", "C"),
    ]).toEqual(["B", "C"])
  })

  it("should name the first stream on show when the pane current after the close is no stream", () => {
    const prev = page("A", "draft:A:msg_1-B")
    expect(streamPaneAfter(prev, closePanelTab(prev, "A"), "A", "draft:A:msg_1")).toBe("B")
  })

  it("should name a covered stream when no stream is on show", () => {
    const prev = page("A", "B.draft:A:msg_1")
    expect(streamPaneAfter(prev, closePanelTab(prev, "A"), "A", "A")).toBe("B")
  })

  it("should name nothing when the last stream pane closes", () => {
    const prev = page("A", "draft:A:msg_1.conv:conv_1")
    expect([
      streamPaneAfter(prev, closePanelTab(prev, "A"), "A", "A"),
      streamPaneAfter(page("A"), closePanelTab(page("A"), "A"), "A", "A"),
    ]).toEqual([null, null])
  })
})

describe("tabsBeside", () => {
  const ids = ["A", "B", "C", "D"]

  it("should take the tabs around, before, after or including a tab, in order", () => {
    expect({
      others: tabsBeside(ids, "B", "others"),
      before: tabsBeside(ids, "B", "before"),
      after: tabsBeside(ids, "B", "after"),
      all: tabsBeside(ids, "B", "all"),
    }).toEqual({ others: ["A", "C", "D"], before: ["A"], after: ["C", "D"], all: ["A", "B", "C", "D"] })
  })

  it("should take nothing before the first tab or after the last", () => {
    expect([tabsBeside(ids, "A", "before"), tabsBeside(ids, "D", "after")]).toEqual([[], []])
  })

  it("should take nothing beside a tab the section doesn't hold", () => {
    expect([tabsBeside(ids, "X", "others"), tabsBeside(ids, "X", "after")]).toEqual([[], []])
  })
})
