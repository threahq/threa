import { describe, expect, it } from "vitest"
import {
  isExplorerOpen,
  readExplorerFiltersFromParams,
  writeExplorerFiltersToParams,
  EXPLORER_PARAM,
} from "./use-explorer-url-state"

describe("isExplorerOpen", () => {
  it("returns true when the marker param is present", () => {
    expect(isExplorerOpen(new URLSearchParams("explorer="))).toBe(true)
    expect(isExplorerOpen(new URLSearchParams("explorer=open"))).toBe(true)
  })

  it("returns false when the marker is absent", () => {
    expect(isExplorerOpen(new URLSearchParams(""))).toBe(false)
    expect(isExplorerOpen(new URLSearchParams("streams=str_1"))).toBe(false)
  })
})

describe("readExplorerFiltersFromParams", () => {
  it("returns workspace-scoped defaults for an empty URL", () => {
    const filters = readExplorerFiltersFromParams(new URLSearchParams(""))
    expect(filters).toEqual({
      streamIds: [],
      queryText: "",
      categories: [],
      uploadedBy: null,
      nameSubstring: null,
      before: null,
      after: null,
      view: "list",
      selectedAttachmentId: null,
    })
  })

  it("parses multi-stream filters and explicit filters", () => {
    const params = new URLSearchParams(
      "explorer=&streams=str_design,str_strategy&q=invoice&type=image,pdf&from=usr_1&name=q2&before=2026-04-01T00:00:00.000Z&after=2026-01-01T00:00:00.000Z&view=grid&selected=attach_1"
    )
    expect(readExplorerFiltersFromParams(params)).toEqual({
      streamIds: ["str_design", "str_strategy"],
      queryText: "invoice",
      categories: ["image", "pdf"],
      uploadedBy: "usr_1",
      nameSubstring: "q2",
      before: "2026-04-01T00:00:00.000Z",
      after: "2026-01-01T00:00:00.000Z",
      view: "grid",
      selectedAttachmentId: "attach_1",
    })
  })

  it("ignores unknown category values rather than throwing", () => {
    const filters = readExplorerFiltersFromParams(new URLSearchParams("type=image,bogus,pdf"))
    expect(filters.categories).toEqual(["image", "pdf"])
  })

  it("dedupes repeated stream IDs and drops empties", () => {
    const filters = readExplorerFiltersFromParams(new URLSearchParams("streams=str_a,,str_b,str_a"))
    expect(filters.streamIds).toEqual(["str_a", "str_b"])
  })
})

describe("writeExplorerFiltersToParams", () => {
  it("round-trips a full filter object back through the params parser", () => {
    const start = new URLSearchParams()
    const written = writeExplorerFiltersToParams(start, {
      streamIds: ["str_design", "str_strategy"],
      queryText: "invoice",
      categories: ["image", "pdf"],
      uploadedBy: "usr_1",
      nameSubstring: "q2",
      before: "2026-04-01T00:00:00.000Z",
      after: "2026-01-01T00:00:00.000Z",
      view: "grid",
      selectedAttachmentId: "attach_1",
    })
    written.set(EXPLORER_PARAM, "")

    const round = readExplorerFiltersFromParams(written)
    expect(round).toEqual({
      streamIds: ["str_design", "str_strategy"],
      queryText: "invoice",
      categories: ["image", "pdf"],
      uploadedBy: "usr_1",
      nameSubstring: "q2",
      before: "2026-04-01T00:00:00.000Z",
      after: "2026-01-01T00:00:00.000Z",
      view: "grid",
      selectedAttachmentId: "attach_1",
    })
  })

  it("clears params when filters are reset to their defaults", () => {
    const initial = new URLSearchParams(
      "streams=str_design&q=invoice&type=image&from=usr_1&name=q2&before=x&after=y&view=grid&selected=attach_1"
    )
    const cleared = writeExplorerFiltersToParams(initial, {
      streamIds: [],
      queryText: "",
      categories: [],
      uploadedBy: null,
      nameSubstring: null,
      before: null,
      after: null,
      view: "list",
      selectedAttachmentId: null,
    })
    expect(cleared.toString()).toBe("")
  })

  it("preserves non-explorer params when narrowing the scope", () => {
    const initial = new URLSearchParams("panel=str_other&explorer=")
    const updated = writeExplorerFiltersToParams(initial, {
      streamIds: ["str_design"],
    })
    expect(updated.get("panel")).toBe("str_other")
    expect(updated.get("streams")).toBe("str_design")
    expect(updated.has("explorer")).toBe(true)
  })
})
