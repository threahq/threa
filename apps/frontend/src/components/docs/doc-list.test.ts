import { describe, expect, it } from "vitest"
import type { DocListItem } from "@threahq/types"
import {
  buildDocRows,
  docListHref,
  docFilterOptions,
  filterDocRows,
  readDocListFilters,
  writeDocListFilters,
  type DocListFilters,
  type DocListStream,
} from "./doc-list"

const NO_FILTERS: DocListFilters = { query: "", host: null, label: null, editor: null }

function stream(id: string, overrides: Partial<DocListStream> = {}): DocListStream {
  return { id, type: "channel", slug: id, displayName: null, createdAt: "2026-10-01T00:00:00.000Z", ...overrides }
}

function doc(id: string, overrides: Partial<DocListStream> = {}): DocListStream {
  return stream(id, { type: "doc", slug: null, parentStreamId: "general", ...overrides })
}

function item(
  id: string,
  editors: [actorId: string, lastEditedAt: string][],
  listed: Pick<DocListItem, "displayName" | "createdAt"> & Partial<Pick<DocListItem, "isTopLevel">> = {
    displayName: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  }
): DocListItem {
  return {
    id,
    ...listed,
    isTopLevel: listed.isTopLevel ?? false,
    lastEditedAt: editors[0]?.[1] ?? null,
    editors: editors.map(([actorId, lastEditedAt]) => ({
      actorId,
      actorType: actorId.startsWith("persona_") ? "persona" : "user",
      lastEditedAt,
    })),
  }
}

const streams = [
  stream("general"),
  stream("design"),
  doc("doc_plan", { displayName: "Launch plan", createdAt: "2026-10-01T00:00:00.000Z" }),
  doc("doc_notes", { displayName: "Design notes", parentStreamId: "design", createdAt: "2026-10-02T00:00:00.000Z" }),
  doc("doc_fresh", { displayName: null, createdAt: "2026-10-20T00:00:00.000Z" }),
  doc("doc_shared", { displayName: "Shared spec", parentStreamId: "stream_unseen" }),
  doc("doc_archived", { displayName: "Old", archivedAt: "2026-10-03T00:00:00.000Z" }),
  doc("doc_stale", { displayName: "Gone from the list", createdAt: "2026-10-09T00:00:00.000Z" }),
  stream("retired", { archivedAt: "2026-10-03T00:00:00.000Z" }),
  doc("doc_sealed", { displayName: "Under a retired host", parentStreamId: "retired" }),
]

const items = [
  item("doc_plan", [
    ["usr_ana", "2026-10-25T00:00:00.000Z"],
    ["persona_ariadne", "2026-10-10T00:00:00.000Z"],
  ]),
  item("doc_notes", [["usr_ben", "2026-10-15T00:00:00.000Z"]]),
  item("doc_shared", [["usr_ana", "2026-10-05T00:00:00.000Z"]]),
  item("doc_granted", [], { displayName: "Granted brief", createdAt: "2026-10-04T00:00:00.000Z", isTopLevel: true }),
  item("doc_archived", []),
  item("doc_sealed", []),
]

const listedAt = Date.parse("2026-10-10T00:00:00.000Z")

const assignments = [
  { labelId: "label_q4", resourceType: "stream", resourceId: "doc_notes" },
  { labelId: "label_q4", resourceType: "message", resourceId: "doc_plan" },
]

const rows = buildDocRows({ streams, items, assignments, listedAt })

describe("buildDocRows", () => {
  it("should list live docs by last edit, else creation, newest first when joined with the list", () => {
    expect(
      rows.map((row) => ({ id: row.doc.id, title: row.title, activityAt: row.activityAt, edited: row.edited }))
    ).toEqual([
      { id: "doc_plan", title: "Launch plan", activityAt: "2026-10-25T00:00:00.000Z", edited: true },
      { id: "doc_fresh", title: "Untitled", activityAt: "2026-10-20T00:00:00.000Z", edited: false },
      { id: "doc_notes", title: "Design notes", activityAt: "2026-10-15T00:00:00.000Z", edited: true },
      { id: "doc_shared", title: "Shared spec", activityAt: "2026-10-05T00:00:00.000Z", edited: true },
      { id: "doc_granted", title: "Granted brief", activityAt: "2026-10-04T00:00:00.000Z", edited: false },
    ])
  })

  it("should drop a cached doc the list lacks when it was created before the list was fetched", () => {
    expect(rows.map((row) => row.doc.id)).not.toContain("doc_stale")
  })

  it("should drop a listed doc when it or its host is archived in the cache", () => {
    expect(rows.map((row) => row.doc.id).filter((id) => id === "doc_archived" || id === "doc_sealed")).toEqual([])
  })

  it("should leave the host empty when the viewer cannot read the doc's host", () => {
    expect(rows.map((row) => [row.doc.id, row.host?.id ?? null])).toEqual([
      ["doc_plan", "general"],
      ["doc_fresh", "general"],
      ["doc_notes", "design"],
      ["doc_shared", null],
      ["doc_granted", null],
    ])
  })

  it("should use listed placement when the doc is absent from cache and retain hosted placement without its host", () => {
    expect(rows.map((row) => [row.doc.id, row.isTopLevel])).toEqual([
      ["doc_plan", false],
      ["doc_fresh", false],
      ["doc_notes", false],
      ["doc_shared", false],
      ["doc_granted", true],
    ])
  })

  it("should carry only stream label assignments when a label row targets another resource type", () => {
    expect(Object.fromEntries(rows.map((row) => [row.doc.id, row.labelIds]))).toEqual({
      doc_plan: [],
      doc_fresh: [],
      doc_notes: ["label_q4"],
      doc_shared: [],
      doc_granted: [],
    })
  })
})

describe("filterDocRows", () => {
  const ids = (filters: Partial<DocListFilters>) =>
    filterDocRows(rows, { ...NO_FILTERS, ...filters }).map((row) => row.doc.id)

  it("should match titles case-insensitively when filtering by text", () => {
    expect(ids({ query: "  NOTES " })).toEqual(["doc_notes"])
  })

  it("should keep only the host's docs when filtering by host", () => {
    expect(ids({ host: "general" })).toEqual(["doc_plan", "doc_fresh"])
  })

  it("should filter top-level docs when their host is not in cache", () => {
    expect(ids({ host: "top-level" })).toEqual(["doc_granted"])
  })

  it("should prefer the cached placement after a move while the list response is stale", () => {
    const staleItems = items.map((listed) => (listed.id === "doc_plan" ? { ...listed, isTopLevel: true } : listed))
    const currentRows = buildDocRows({ streams, items: staleItems, assignments, listedAt })
    expect(filterDocRows(currentRows, { ...NO_FILTERS, host: "top-level" }).map(({ doc }) => doc.id)).toEqual([
      "doc_granted",
    ])
  })

  it("should keep only labeled docs when filtering by label", () => {
    expect(ids({ label: "label_q4" })).toEqual(["doc_notes"])
  })

  it("should keep every doc an actor edited when filtering by editor", () => {
    expect(ids({ editor: "usr_ana" })).toEqual(["doc_plan", "doc_shared"])
  })

  it("should require every filter when several are set", () => {
    expect(ids({ editor: "usr_ana", host: "general", query: "spec" })).toEqual([])
  })
})

describe("docFilterOptions", () => {
  it("should offer hosts by name, labels in use and editors by latest edit when built from the rows", () => {
    const options = docFilterOptions(rows)
    expect({
      hosts: options.hosts.map(({ host, name }) => [host.id, name]),
      labelIds: [...options.labelIds],
      editors: options.editors.map((editor) => [editor.actorId, editor.lastEditedAt]),
    }).toEqual({
      hosts: [
        ["design", "#design"],
        ["general", "#general"],
      ],
      labelIds: ["label_q4"],
      editors: [
        ["usr_ana", "2026-10-25T00:00:00.000Z"],
        ["usr_ben", "2026-10-15T00:00:00.000Z"],
        ["persona_ariadne", "2026-10-10T00:00:00.000Z"],
      ],
    })
  })
})

describe("doc list search params", () => {
  it("should round-trip filters and drop cleared ones when written to the URL", () => {
    const written = writeDocListFilters(new URLSearchParams("host=general&other=1"), {
      query: "plan",
      host: null,
      editor: "usr_ana",
    })
    expect({ search: written.toString(), filters: readDocListFilters(written) }).toEqual({
      search: "other=1&q=plan&editor=usr_ana",
      filters: { query: "plan", host: null, label: null, editor: "usr_ana" },
    })
  })

  it("should keep other params and drop the query when empty when building the docs href", () => {
    const params = new URLSearchParams("panel=doc_plan&q=plan&host=general")
    expect([
      docListHref("ws_1", new URLSearchParams()),
      docListHref("ws_1", new URLSearchParams(), { host: "top-level" }),
      docListHref("ws_1", params, { query: "", host: null, label: null, editor: null }),
    ]).toEqual(["/w/ws_1/docs", "/w/ws_1/docs?host=top-level", "/w/ws_1/docs?panel=doc_plan"])
  })
})
