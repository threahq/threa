import { describe, it, expect } from "vitest"
import { SMART_SIDEBAR_CONFIG, ALL_SIDEBAR_CONFIG, QUICK_LINKS_SECTION_ID } from "@threahq/types"
import {
  hasLabelSection,
  labelSectionId,
  toggleLabelSection,
  sectionIdForSpec,
  customSectionId,
  hasSection,
  addSection,
  addSectionAt,
  removeSection,
  moveSection,
  isPristinePreset,
  setQuickLinkVisibility,
  moveQuickLink,
  createCustomSection,
  renameCustomSection,
  customSections,
  getStreamCustomSectionId,
  setStreamCustomSection,
  setSectionFilter,
  setSectionOrder,
  setSectionReverse,
} from "./sidebar-config"

describe("toggleLabelSection", () => {
  it("appends a label section when absent and reports it as pinned", () => {
    expect(hasLabelSection(SMART_SIDEBAR_CONFIG, "lbl_1")).toBe(false)

    const next = toggleLabelSection(SMART_SIDEBAR_CONFIG, "lbl_1")

    expect(hasLabelSection(next, "lbl_1")).toBe(true)
    // Appended at the end; existing sections untouched.
    expect(next.sections.slice(0, -1)).toEqual(SMART_SIDEBAR_CONFIG.sections)
    expect(next.sections.at(-1)).toEqual({
      id: labelSectionId("lbl_1"),
      spec: { kind: "label", labelId: "lbl_1" },
    })
  })

  it("removes the label section when already present (idempotent toggle)", () => {
    const pinned = toggleLabelSection(SMART_SIDEBAR_CONFIG, "lbl_1")
    const unpinned = toggleLabelSection(pinned, "lbl_1")

    expect(hasLabelSection(unpinned, "lbl_1")).toBe(false)
    expect(unpinned.sections).toEqual(SMART_SIDEBAR_CONFIG.sections)
  })

  it("only toggles the targeted label, leaving other label sections intact", () => {
    const withTwo = toggleLabelSection(toggleLabelSection(SMART_SIDEBAR_CONFIG, "lbl_1"), "lbl_2")
    const dropped = toggleLabelSection(withTwo, "lbl_1")

    expect(hasLabelSection(dropped, "lbl_1")).toBe(false)
    expect(hasLabelSection(dropped, "lbl_2")).toBe(true)
  })
})

describe("sectionIdForSpec", () => {
  it("derives the stable ids the presets hard-code (so collapse state survives re-add)", () => {
    expect(sectionIdForSpec({ kind: "smart", bucket: "important" })).toBe("important")
    expect(sectionIdForSpec({ kind: "type", streamType: "scratchpad" })).toBe("scratchpads")
    expect(sectionIdForSpec({ kind: "type", streamType: "dm" })).toBe("dms")
    expect(sectionIdForSpec({ kind: "label", labelId: "lbl_1" })).toBe(labelSectionId("lbl_1"))
    expect(sectionIdForSpec({ kind: "custom", sectionId: "sec_1", name: "Work", streamIds: [] })).toBe(
      customSectionId("sec_1")
    )
    expect(sectionIdForSpec({ kind: "quicklinks" })).toBe(QUICK_LINKS_SECTION_ID)
  })
})

describe("custom sections", () => {
  it("createCustomSection appends a trimmed, empty section and rejects a blank name", () => {
    const next = createCustomSection(SMART_SIDEBAR_CONFIG, "sec_1", "  Work  ")
    expect(next.sections.at(-1)).toEqual({
      id: customSectionId("sec_1"),
      spec: { kind: "custom", sectionId: "sec_1", name: "Work", streamIds: [] },
    })
    // Existing sections untouched.
    expect(next.sections.slice(0, -1)).toEqual(SMART_SIDEBAR_CONFIG.sections)
    // A blank name is a no-op.
    expect(createCustomSection(SMART_SIDEBAR_CONFIG, "sec_2", "   ")).toEqual(SMART_SIDEBAR_CONFIG)
  })

  it("renameCustomSection trims the new name and no-ops for blanks / unknown ids", () => {
    const created = createCustomSection(SMART_SIDEBAR_CONFIG, "sec_1", "Work")
    const renamed = renameCustomSection(created, "sec_1", "  Personal ")
    expect(customSections(renamed)).toEqual([{ kind: "custom", sectionId: "sec_1", name: "Personal", streamIds: [] }])
    expect(renameCustomSection(created, "sec_1", "  ")).toEqual(created)
    expect(renameCustomSection(created, "ghost", "X")).toEqual(created)
  })

  it("renameCustomSection preserves referential identity on a no-op rename", () => {
    const created = createCustomSection(SMART_SIDEBAR_CONFIG, "sec_1", "Work")
    // Same name (after trim) and unknown id both return the original object, so
    // the optimistic-write identity check skips a needless persist + resubscribe.
    expect(renameCustomSection(created, "sec_1", "Work")).toBe(created)
    expect(renameCustomSection(created, "sec_1", "  Work  ")).toBe(created)
    expect(renameCustomSection(created, "ghost", "Other")).toBe(created)
  })

  it("setStreamCustomSection leaves membership untouched when the target section is missing", () => {
    const config = setStreamCustomSection(createCustomSection(SMART_SIDEBAR_CONFIG, "sec_a", "A"), "stream_1", "sec_a")
    // Filing into a section that no longer exists must not strip the stream from
    // the section it's currently in — it's a no-op that returns the same object.
    const result = setStreamCustomSection(config, "stream_1", "ghost")
    expect(result).toBe(config)
    expect(getStreamCustomSectionId(result, "stream_1")).toBe("sec_a")
  })

  it("setStreamCustomSection files a stream exclusively, moving it between sections", () => {
    let config = createCustomSection(SMART_SIDEBAR_CONFIG, "sec_a", "A")
    config = createCustomSection(config, "sec_b", "B")

    const filed = setStreamCustomSection(config, "stream_1", "sec_a")
    expect(getStreamCustomSectionId(filed, "stream_1")).toBe("sec_a")

    // Moving to B removes it from A — a stream lives in only one custom section.
    const moved = setStreamCustomSection(filed, "stream_1", "sec_b")
    expect(getStreamCustomSectionId(moved, "stream_1")).toBe("sec_b")
    expect(customSections(moved).find((s) => s.sectionId === "sec_a")?.streamIds).toEqual([])
    expect(customSections(moved).find((s) => s.sectionId === "sec_b")?.streamIds).toEqual(["stream_1"])
  })

  it("setStreamCustomSection with null removes the stream from every custom section", () => {
    const config = setStreamCustomSection(createCustomSection(SMART_SIDEBAR_CONFIG, "sec_a", "A"), "stream_1", "sec_a")
    const cleared = setStreamCustomSection(config, "stream_1", null)
    expect(getStreamCustomSectionId(cleared, "stream_1")).toBeNull()
  })

  it("getStreamCustomSectionId returns null when the stream is unfiled", () => {
    const config = createCustomSection(SMART_SIDEBAR_CONFIG, "sec_a", "A")
    expect(getStreamCustomSectionId(config, "stream_x")).toBeNull()
  })

  it("makes the layout diverge from its preset (custom is never pristine)", () => {
    expect(isPristinePreset(createCustomSection(SMART_SIDEBAR_CONFIG, "sec_1", "Work"))).toBeNull()
  })
})

describe("setSectionFilter", () => {
  it("sets the filter to unread on a section that had none", () => {
    const sectionId = SMART_SIDEBAR_CONFIG.sections[0].id
    const next = setSectionFilter(SMART_SIDEBAR_CONFIG, sectionId, "unread")
    expect(next.sections.find((s) => s.id === sectionId)?.filter).toBe("unread")
  })

  it("clears the filter back to absent when set to all", () => {
    const sectionId = SMART_SIDEBAR_CONFIG.sections[0].id
    const filtered = setSectionFilter(SMART_SIDEBAR_CONFIG, sectionId, "unread")
    const cleared = setSectionFilter(filtered, sectionId, "all")
    expect(cleared.sections.find((s) => s.id === sectionId)?.filter).toBeUndefined()
  })

  it("returns the same object for an unknown section id", () => {
    expect(setSectionFilter(SMART_SIDEBAR_CONFIG, "ghost", "unread")).toBe(SMART_SIDEBAR_CONFIG)
  })

  it("returns the same object when the filter already matches (no-op)", () => {
    const sectionId = SMART_SIDEBAR_CONFIG.sections[0].id
    expect(setSectionFilter(SMART_SIDEBAR_CONFIG, sectionId, "all")).toBe(SMART_SIDEBAR_CONFIG)
    const filtered = setSectionFilter(SMART_SIDEBAR_CONFIG, sectionId, "unread")
    expect(setSectionFilter(filtered, sectionId, "unread")).toBe(filtered)
  })

  it("leaves other sections untouched", () => {
    const sectionId = SMART_SIDEBAR_CONFIG.sections[0].id
    const next = setSectionFilter(SMART_SIDEBAR_CONFIG, sectionId, "unread")
    expect(next.sections.slice(1)).toEqual(SMART_SIDEBAR_CONFIG.sections.slice(1))
  })
})

describe("setSectionOrder", () => {
  it("should store a non-default order", () => {
    const next = setSectionOrder(ALL_SIDEBAR_CONFIG, "channels", "activity")
    expect(next.sections.find((s) => s.id === "channels")).toEqual({
      id: "channels",
      spec: { kind: "type", streamType: "channel" },
      order: "activity",
    })
  })

  it("should write the section's default order as absent", () => {
    const sorted = setSectionOrder(ALL_SIDEBAR_CONFIG, "channels", "activity")
    const reset = setSectionOrder(sorted, "channels", "name")
    expect(reset.sections).toEqual(ALL_SIDEBAR_CONFIG.sections)
  })

  it("should write null as absent on sections whose default is the mixed order", () => {
    const sorted = setSectionOrder(SMART_SIDEBAR_CONFIG, "other", "name")
    expect(setSectionOrder(sorted, "other", null).sections).toEqual(SMART_SIDEBAR_CONFIG.sections)
  })

  it("should return the same object when the order already applies", () => {
    expect(setSectionOrder(ALL_SIDEBAR_CONFIG, "channels", "name")).toBe(ALL_SIDEBAR_CONFIG)
    expect(setSectionOrder(ALL_SIDEBAR_CONFIG, "ghost", "name")).toBe(ALL_SIDEBAR_CONFIG)
  })
})

describe("setSectionReverse", () => {
  it("should store reverse only while it is on", () => {
    const reversed = setSectionReverse(ALL_SIDEBAR_CONFIG, "dms", true)
    expect(reversed.sections.find((s) => s.id === "dms")?.reverse).toBe(true)
    expect(setSectionReverse(reversed, "dms", false).sections).toEqual(ALL_SIDEBAR_CONFIG.sections)
  })

  it("should return the same object when nothing changes", () => {
    expect(setSectionReverse(ALL_SIDEBAR_CONFIG, "dms", false)).toBe(ALL_SIDEBAR_CONFIG)
  })
})

describe("addSectionAt", () => {
  it("inserts the section at the given index, shifting the rest", () => {
    // Drop a Recent bucket at the front of the All preset.
    const added = addSectionAt(ALL_SIDEBAR_CONFIG, { kind: "smart", bucket: "recent" }, 0)
    expect(added.sections[0]).toEqual({ id: "recent", spec: { kind: "smart", bucket: "recent" } })
    expect(added.sections.slice(1)).toEqual(ALL_SIDEBAR_CONFIG.sections)
  })

  it("clamps an out-of-range index and is a no-op when already present", () => {
    const appended = addSectionAt(ALL_SIDEBAR_CONFIG, { kind: "smart", bucket: "important" }, 999)
    expect(appended.sections.at(-1)).toEqual({ id: "important", spec: { kind: "smart", bucket: "important" } })
    // The quick-links block is already in the preset — re-adding changes nothing.
    expect(addSectionAt(ALL_SIDEBAR_CONFIG, { kind: "quicklinks" }, 2)).toEqual(ALL_SIDEBAR_CONFIG)
  })
})

describe("addSection / removeSection", () => {
  it("appends a section and is a no-op when already present", () => {
    const added = addSection(ALL_SIDEBAR_CONFIG, { kind: "smart", bucket: "important" })
    expect(added.sections.at(-1)).toEqual({ id: "important", spec: { kind: "smart", bucket: "important" } })
    expect(hasSection(added, { kind: "smart", bucket: "important" })).toBe(true)

    // Re-adding the same spec changes nothing.
    expect(addSection(added, { kind: "smart", bucket: "important" })).toEqual(added)
  })

  it("removes a section by id and is a no-op for an unknown id", () => {
    const removed = removeSection(SMART_SIDEBAR_CONFIG, "recent")
    expect(removed).toEqual({
      ...SMART_SIDEBAR_CONFIG,
      sections: SMART_SIDEBAR_CONFIG.sections.filter((s) => s.id !== "recent"),
    })
    expect(removeSection(SMART_SIDEBAR_CONFIG, "nope")).toEqual(SMART_SIDEBAR_CONFIG)
  })
})

describe("setQuickLinkVisibility", () => {
  it("sets a link's visibility and leaves the rest (and order) untouched", () => {
    const hidden = setQuickLinkVisibility(SMART_SIDEBAR_CONFIG, "labels", "hidden")
    expect(hidden.quickLinks.find((l) => l.key === "labels")?.visibility).toBe("hidden")
    expect(hidden.quickLinks.map((l) => l.key)).toEqual(SMART_SIDEBAR_CONFIG.quickLinks.map((l) => l.key))
    // Setting back to "show" restores the original.
    expect(setQuickLinkVisibility(hidden, "labels", "show")).toEqual(SMART_SIDEBAR_CONFIG)
  })

  it("allows 'active' for a link with a live signal", () => {
    const next = setQuickLinkVisibility(SMART_SIDEBAR_CONFIG, "drafts", "active")
    expect(next.quickLinks.find((l) => l.key === "drafts")?.visibility).toBe("active")
  })

  it("coerces 'active' to 'show' for a link without a live signal", () => {
    // Files has no count/badge, so "show when active" is meaningless.
    const next = setQuickLinkVisibility(SMART_SIDEBAR_CONFIG, "files", "active")
    expect(next.quickLinks.find((l) => l.key === "files")?.visibility).toBe("show")
  })

  it("is a no-op for an unknown key", () => {
    expect(setQuickLinkVisibility(SMART_SIDEBAR_CONFIG, "nope" as never, "hidden")).toEqual(SMART_SIDEBAR_CONFIG)
  })
})

describe("moveQuickLink", () => {
  it("moves a link to another's position, shifting the rest", () => {
    // Move "activity" (last) to the front (over "drafts").
    const moved = moveQuickLink(SMART_SIDEBAR_CONFIG, "activity", "drafts")
    expect(moved.quickLinks.map((l) => l.key)).toEqual([
      "activity",
      "drafts",
      "saved",
      "streams",
      "files",
      "scheduled",
      "agenda",
      "memory",
      "labels",
    ])
  })

  it("is a no-op when keys match or are missing", () => {
    expect(moveQuickLink(SMART_SIDEBAR_CONFIG, "drafts", "drafts")).toEqual(SMART_SIDEBAR_CONFIG)
    expect(moveQuickLink(SMART_SIDEBAR_CONFIG, "drafts", "ghost")).toEqual(SMART_SIDEBAR_CONFIG)
  })
})

describe("moveSection", () => {
  it("moves a section to another's position, shifting the rest", () => {
    // Move "other" over "important" (after the quick-links block the preset leads with).
    const moved = moveSection(SMART_SIDEBAR_CONFIG, "other", "important")
    expect(moved.sections.map((s) => s.id)).toEqual(["quick-links", "other", "important", "recent"])
  })

  it("is a no-op when ids match or are missing", () => {
    expect(moveSection(SMART_SIDEBAR_CONFIG, "recent", "recent")).toEqual(SMART_SIDEBAR_CONFIG)
    expect(moveSection(SMART_SIDEBAR_CONFIG, "recent", "ghost")).toEqual(SMART_SIDEBAR_CONFIG)
  })
})

describe("isPristinePreset", () => {
  it("matches the presets and returns null once the layout diverges", () => {
    expect(isPristinePreset(SMART_SIDEBAR_CONFIG)).toBe("smart")
    expect(isPristinePreset(ALL_SIDEBAR_CONFIG)).toBe("all")
    // Order matters: a reordered Smart layout is custom.
    expect(isPristinePreset(moveSection(SMART_SIDEBAR_CONFIG, "other", "important"))).toBeNull()
    // So does membership: a pinned label makes it custom.
    expect(isPristinePreset(toggleLabelSection(SMART_SIDEBAR_CONFIG, "lbl_1"))).toBeNull()
    // And so does a quick-link change, even with the sections untouched.
    expect(isPristinePreset(setQuickLinkVisibility(SMART_SIDEBAR_CONFIG, "drafts", "hidden"))).toBeNull()
    // Removing the quick-links section diverges from the preset too.
    expect(isPristinePreset(removeSection(SMART_SIDEBAR_CONFIG, QUICK_LINKS_SECTION_ID))).toBeNull()
  })
})
