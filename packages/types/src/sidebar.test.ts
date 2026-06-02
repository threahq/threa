import { describe, test, expect } from "bun:test"
import {
  normalizeSidebarConfig,
  SIDEBAR_CONFIG_VERSION,
  QUICK_LINKS_SECTION_ID,
  MAX_CUSTOM_SECTION_STREAM_IDS,
  type RawSidebarConfig,
  type SidebarSection,
} from "./sidebar"

describe("normalizeSidebarConfig section sanitization", () => {
  test("drops sections whose spec is an unknown smart bucket", () => {
    const config: RawSidebarConfig = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart",
      sections: [
        { id: "important", spec: { kind: "smart", bucket: "important" } },
        // Stale row from an older client — bucket no longer exists. Rendering it
        // would crash the whole sidebar via the presentation lookup.
        { id: "legacy", spec: { kind: "smart", bucket: "urgent" } } as unknown as SidebarSection,
        { id: "recent", spec: { kind: "smart", bucket: "recent" } },
      ],
      quickLinks: [],
    }

    const result = normalizeSidebarConfig(config)

    expect(result.sections.map((s) => s.id)).toEqual(["important", "recent"])
  })

  test("drops sections with an unknown stream type or a label missing its id", () => {
    const config: RawSidebarConfig = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "all",
      sections: [
        { id: "channels", spec: { kind: "type", streamType: "channel" } },
        { id: "ghosts", spec: { kind: "type", streamType: "ghost" } } as unknown as SidebarSection,
        { id: "label:", spec: { kind: "label", labelId: "" } } as unknown as SidebarSection,
        { id: "label:keep", spec: { kind: "label", labelId: "label_123" } },
      ],
      quickLinks: [],
    }

    const result = normalizeSidebarConfig(config)

    expect(result.sections.map((s) => s.id)).toEqual(["channels", "label:keep"])
  })

  test("drops malformed (spec-less) section rows without throwing", () => {
    const config = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart",
      sections: [
        { id: "important", spec: { kind: "smart", bucket: "important" } },
        { id: "broken" }, // missing spec entirely
        null,
      ],
      quickLinks: [],
    } as unknown as RawSidebarConfig

    const result = normalizeSidebarConfig(config)

    expect(result.sections.map((s) => s.id)).toEqual(["important"])
  })

  test("keeps the quick-links section and all valid specs intact", () => {
    const config: RawSidebarConfig = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart",
      sections: [
        { id: QUICK_LINKS_SECTION_ID, spec: { kind: "quicklinks" } },
        { id: "important", spec: { kind: "smart", bucket: "important" } },
      ],
      quickLinks: [],
    }

    const result = normalizeSidebarConfig(config)

    expect(result.sections.map((s) => s.spec.kind)).toEqual(["quicklinks", "smart"])
  })

  test("drops a custom section with a blank name but keeps a valid one", () => {
    const config: RawSidebarConfig = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart",
      sections: [
        { id: "custom:blank", spec: { kind: "custom", sectionId: "blank", name: "   ", streamIds: [] } },
        { id: "custom:work", spec: { kind: "custom", sectionId: "work", name: "Work", streamIds: ["s1"] } },
      ],
      quickLinks: [],
    }

    const result = normalizeSidebarConfig(config)

    expect(result.sections.map((s) => s.id)).toEqual(["custom:work"])
  })

  test("sanitizes custom-section streamIds and enforces single membership across sections", () => {
    const config = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart",
      sections: [
        // Non-string ids and an in-section duplicate are stripped.
        { id: "custom:a", spec: { kind: "custom", sectionId: "a", name: "A", streamIds: ["s1", "s1", 7, "s2"] } },
        // s2 already lives in A, so the first listing wins and B keeps only s3.
        { id: "custom:b", spec: { kind: "custom", sectionId: "b", name: "B", streamIds: ["s2", "s3"] } },
      ],
      quickLinks: [],
    } as unknown as RawSidebarConfig

    const result = normalizeSidebarConfig(config)
    const byId = (id: string) => result.sections.find((s) => s.id === id)?.spec

    expect(byId("custom:a")).toMatchObject({ streamIds: ["s1", "s2"] })
    expect(byId("custom:b")).toMatchObject({ streamIds: ["s3"] })
  })

  test("coerces a custom section's missing/non-array streamIds to an empty list", () => {
    const config = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart",
      sections: [{ id: "custom:a", spec: { kind: "custom", sectionId: "a", name: "A" } }],
      quickLinks: [],
    } as unknown as RawSidebarConfig

    const result = normalizeSidebarConfig(config)

    expect(result.sections[0].spec).toMatchObject({ kind: "custom", streamIds: [] })
  })

  test("caps a custom section's streamIds at the write-time bound on read", () => {
    const streamIds = Array.from({ length: MAX_CUSTOM_SECTION_STREAM_IDS + 25 }, (_, i) => `s${i}`)
    const config = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart",
      sections: [{ id: "custom:a", spec: { kind: "custom", sectionId: "a", name: "A", streamIds } }],
      quickLinks: [],
    } as unknown as RawSidebarConfig

    const result = normalizeSidebarConfig(config)
    const spec = result.sections[0].spec
    if (spec.kind !== "custom") throw new Error("expected a custom section")
    expect(spec.streamIds).toHaveLength(MAX_CUSTOM_SECTION_STREAM_IDS)
  })
})
