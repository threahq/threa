import { describe, it, expect } from "vitest"
import { SMART_SIDEBAR_CONFIG, ALL_SIDEBAR_CONFIG } from "@threa/types"
import {
  hasLabelSection,
  labelSectionId,
  toggleLabelSection,
  sectionIdForSpec,
  hasSection,
  addSection,
  removeSection,
  moveSection,
  isPristinePreset,
  toggleQuickLink,
  moveQuickLink,
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

describe("toggleQuickLink", () => {
  it("flips a link's visibility and leaves the rest (and order) untouched", () => {
    const hidden = toggleQuickLink(SMART_SIDEBAR_CONFIG, "labels")
    expect(hidden.quickLinks.find((l) => l.key === "labels")?.enabled).toBe(false)
    expect(hidden.quickLinks.map((l) => l.key)).toEqual(SMART_SIDEBAR_CONFIG.quickLinks.map((l) => l.key))
    // Toggling back restores the original.
    expect(toggleQuickLink(hidden, "labels")).toEqual(SMART_SIDEBAR_CONFIG)
  })

  it("is a no-op for an unknown key", () => {
    expect(toggleQuickLink(SMART_SIDEBAR_CONFIG, "nope" as never)).toEqual(SMART_SIDEBAR_CONFIG)
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
      "files",
      "scheduled",
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
    // Move "pinned" to the front (over "important").
    const moved = moveSection(SMART_SIDEBAR_CONFIG, "pinned", "important")
    expect(moved.sections.map((s) => s.id)).toEqual(["pinned", "important", "recent", "other"])
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
    expect(isPristinePreset(moveSection(SMART_SIDEBAR_CONFIG, "pinned", "important"))).toBeNull()
    // So does membership: a pinned label makes it custom.
    expect(isPristinePreset(toggleLabelSection(SMART_SIDEBAR_CONFIG, "lbl_1"))).toBeNull()
    // And so does a quick-link change, even with the sections untouched.
    expect(isPristinePreset(toggleQuickLink(SMART_SIDEBAR_CONFIG, "drafts"))).toBeNull()
  })
})
