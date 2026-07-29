import { createElement } from "react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useExplorerUrlState } from "@/components/attachment-explorer/use-explorer-url-state"
import {
  OUTCOMES_PARAM,
  isOutcomesOpen,
  readOutcomesFiltersFromParams,
  useOutcomesUrlState,
  writeOutcomesFiltersToParams,
} from "./use-outcomes-url-state"

describe("isOutcomesOpen", () => {
  it("returns true when the marker param is present", () => {
    expect(isOutcomesOpen(new URLSearchParams("agenda="))).toBe(true)
    expect(isOutcomesOpen(new URLSearchParams("agenda=open"))).toBe(true)
  })

  it("returns false when the marker is absent", () => {
    expect(isOutcomesOpen(new URLSearchParams(""))).toBe(false)
    expect(isOutcomesOpen(new URLSearchParams("aStreams=str_1"))).toBe(false)
  })
})

describe("readOutcomesFiltersFromParams", () => {
  it("defaults to outstanding, both kinds, workspace-wide", () => {
    expect(readOutcomesFiltersFromParams(new URLSearchParams(""))).toEqual({
      streamIds: [],
      state: "outstanding",
      kind: null,
      queryText: "",
      selectedOutcomeId: null,
    })
  })

  it("parses every param", () => {
    const params = new URLSearchParams(
      "agenda=&aStreams=str_design,str_strategy&aState=settled&aKind=delegation&aq=migration&aSelected=deleg_1"
    )
    expect(readOutcomesFiltersFromParams(params)).toEqual({
      streamIds: ["str_design", "str_strategy"],
      state: "settled",
      kind: "delegation",
      queryText: "migration",
      selectedOutcomeId: "deleg_1",
    })
  })

  it("falls back to the defaults for unknown state and kind values", () => {
    const filters = readOutcomesFiltersFromParams(new URLSearchParams("aState=bogus&aKind=bogus"))
    expect(filters.state).toBe("outstanding")
    expect(filters.kind).toBe(null)
  })

  it("dedupes repeated stream IDs and drops empties", () => {
    expect(readOutcomesFiltersFromParams(new URLSearchParams("aStreams=str_a,,str_b,str_a")).streamIds).toEqual([
      "str_a",
      "str_b",
    ])
  })

  it("treats an absent streams param as workspace-wide", () => {
    expect(readOutcomesFiltersFromParams(new URLSearchParams("agenda=")).streamIds).toEqual([])
  })
})

describe("writeOutcomesFiltersToParams", () => {
  it("round-trips a full filter object back through the parser", () => {
    const written = writeOutcomesFiltersToParams(new URLSearchParams(), {
      streamIds: ["str_design", "str_strategy"],
      state: "all",
      kind: "follow_up",
      queryText: "migration",
      selectedOutcomeId: "fup_1",
    })
    written.set(OUTCOMES_PARAM, "")

    expect(readOutcomesFiltersFromParams(written)).toEqual({
      streamIds: ["str_design", "str_strategy"],
      state: "all",
      kind: "follow_up",
      queryText: "migration",
      selectedOutcomeId: "fup_1",
    })
  })

  it("clears params when filters are reset to their defaults", () => {
    const initial = new URLSearchParams("aStreams=str_design&aState=all&aKind=delegation&aq=x&aSelected=deleg_1")
    const cleared = writeOutcomesFiltersToParams(initial, {
      streamIds: [],
      state: "outstanding",
      kind: null,
      queryText: "",
      selectedOutcomeId: null,
    })
    expect(cleared.toString()).toBe("")
  })

  it("preserves non-outcomes params when narrowing the scope", () => {
    const initial = new URLSearchParams("panel=str_other&agenda=")
    const updated = writeOutcomesFiltersToParams(initial, { streamIds: ["str_design"] })
    expect(updated.get("panel")).toBe("str_other")
    expect(updated.get("aStreams")).toBe("str_design")
    expect(updated.has("agenda")).toBe(true)
  })

  it("widens to workspace scope by dropping the streams param", () => {
    const initial = new URLSearchParams("agenda=&aStreams=str_design")
    const widened = writeOutcomesFiltersToParams(initial, { streamIds: [] })
    expect(widened.has("aStreams")).toBe(false)
    expect(readOutcomesFiltersFromParams(widened).streamIds).toEqual([])
  })
})

describe("useOutcomesUrlState", () => {
  function renderUrlState(initialEntry: string) {
    return renderHook(() => ({ state: useOutcomesUrlState(), location: useLocation() }), {
      wrapper: ({ children }) => createElement(MemoryRouter, { initialEntries: [initialEntry] }, children),
    })
  }

  it("close strips only the outcomes-owned keys", () => {
    const { result } = renderUrlState(
      "/w/ws_1?panel=str_other&m=msg_1&agenda=&aStreams=str_a&aState=all&aKind=delegation&aq=x&aSelected=deleg_1"
    )

    expect(result.current.state.isOpen).toBe(true)
    act(() => result.current.state.close())

    const params = new URLSearchParams(result.current.location.search)
    expect(params.get("panel")).toBe("str_other")
    expect(params.get("m")).toBe("msg_1")
    expect([...params.keys()].sort()).toEqual(["m", "panel"])
  })

  it("update writes a filter into the URL and reads it back", () => {
    const { result } = renderUrlState("/w/ws_1?agenda=")

    act(() => result.current.state.update({ state: "settled", kind: "delegation" }))

    expect(result.current.state.filters.state).toBe("settled")
    expect(result.current.state.filters.kind).toBe("delegation")
    expect(new URLSearchParams(result.current.location.search).has("agenda")).toBe(true)
  })

  it("survives the attachment explorer opening and closing on the same route", () => {
    const { result } = renderHook(
      () => ({
        outcomes: useOutcomesUrlState(),
        explorer: useExplorerUrlState(),
      }),
      {
        wrapper: ({ children }) =>
          createElement(
            MemoryRouter,
            { initialEntries: ["/w/ws_1/agenda?aStreams=str_design&aq=migration&aSelected=fup_7&aKind=follow_up"] },
            children
          ),
      }
    )

    const before = result.current.outcomes.filters

    act(() => result.current.explorer.open({ streamIds: [] }))
    expect(result.current.explorer.isOpen).toBe(true)
    expect(result.current.outcomes.filters).toEqual(before)

    act(() => result.current.explorer.close())
    expect(result.current.explorer.isOpen).toBe(false)
    expect(result.current.outcomes.filters).toEqual(before)
    expect(before).toEqual({
      streamIds: ["str_design"],
      state: "outstanding",
      kind: "follow_up",
      queryText: "migration",
      selectedOutcomeId: "fup_7",
    })
  })

  it("open marks the surface open without disturbing existing params", () => {
    const { result } = renderUrlState("/w/ws_1?panel=str_other")

    act(() => result.current.state.open({ streamIds: ["str_a"] }))

    expect(result.current.state.isOpen).toBe(true)
    const params = new URLSearchParams(result.current.location.search)
    expect(params.get("panel")).toBe("str_other")
    expect(params.get("aStreams")).toBe("str_a")
  })
})
