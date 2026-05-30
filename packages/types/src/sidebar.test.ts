import { describe, test, expect } from "bun:test"
import {
  normalizeSidebarConfig,
  SIDEBAR_CONFIG_VERSION,
  QUICK_LINKS_SECTION_ID,
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
})
