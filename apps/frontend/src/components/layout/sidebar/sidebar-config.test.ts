import { describe, it, expect } from "vitest"
import { SMART_SIDEBAR_CONFIG } from "@threa/types"
import { hasLabelSection, labelSectionId, toggleLabelSection } from "./sidebar-config"

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
