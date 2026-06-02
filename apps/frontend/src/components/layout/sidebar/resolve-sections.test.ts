import { describe, it, expect } from "vitest"
import {
  StreamTypes,
  Visibilities,
  ALL_SIDEBAR_CONFIG,
  SMART_SIDEBAR_CONFIG,
  SIDEBAR_CONFIG_VERSION,
} from "@threa/types"
import { resolveSections, type ResolveSectionsInput } from "./resolve-sections"
import { customSectionId, labelSectionId } from "./sidebar-config"
import type { SectionKey, StreamItemData, UrgencyLevel } from "./types"

interface ItemOverrides {
  id: string
  section?: SectionKey
  urgency?: UrgencyLevel
  type?: StreamItemData["type"]
  displayName?: string | null
  slug?: string | null
  /** Minutes since epoch for the last message — controls activity ordering. */
  activity?: number
}

function makeItem(overrides: ItemOverrides): StreamItemData {
  const { id, section = "other", urgency = "quiet", type = StreamTypes.SCRATCHPAD, activity = 0 } = overrides
  const createdAt = new Date(activity * 60_000).toISOString()
  return {
    id,
    workspaceId: "ws_1",
    type,
    displayName: overrides.displayName ?? id,
    slug: overrides.slug ?? null,
    description: null,
    visibility: Visibilities.PRIVATE,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    lastMessagePreview: { authorId: "user_2", authorType: "user", content: "x", createdAt },
    urgency,
    section,
  }
}

/** Fill resolver-input defaults so each test only states what it cares about. */
function makeInput(
  over: Partial<ResolveSectionsInput> & Pick<ResolveSectionsInput, "processedStreams">
): ResolveSectionsInput {
  return { virtualDmStreams: [], getUnreadCount: () => 0, streamIdsByLabel: new Map(), ...over }
}

/**
 * Collapse the resolver output to a comparable shape: section id → item ids.
 * The quick-links block is a positional placeholder that draws no streams, so it
 * is dropped here — these tests are about how streams partition into sections.
 */
function shape(over: Parameters<typeof makeInput>[0], preset = SMART_SIDEBAR_CONFIG) {
  return resolveSections(preset, makeInput(over))
    .filter((resolved) => resolved.section.spec.kind !== "quicklinks")
    .map((resolved) => ({
      id: resolved.section.id,
      items: resolved.items.map((item) => item.id),
    }))
}

function unreadFrom(unreadIds: Set<string>) {
  return (streamId: string) => (unreadIds.has(streamId) ? 1 : 0)
}

describe("resolveSections — Smart preset", () => {
  it("partitions streams into important / recent / pinned / other buckets", () => {
    const processedStreams = [
      makeItem({ id: "imp_1", section: "important", urgency: "mentions" }),
      makeItem({ id: "rec_1", section: "recent", activity: 10 }),
      makeItem({ id: "pin_1", section: "pinned", activity: 5 }),
      makeItem({ id: "oth_1", section: "other", activity: 1 }),
    ]
    const virtualDmStreams = [makeItem({ id: "vdm_1", section: "other", type: StreamTypes.DM, activity: 2 })]

    expect(shape({ processedStreams, virtualDmStreams, getUnreadCount: () => 0 })).toEqual([
      { id: "important", items: ["imp_1"] },
      { id: "recent", items: ["rec_1"] },
      { id: "pinned", items: ["pin_1"] },
      // virtual DMs carry section "other", so they join the Everything Else bucket,
      // sorted by activity (vdm_1 @2 before oth_1 @1).
      { id: "other", items: ["vdm_1", "oth_1"] },
    ])
  })

  it("caps Important at 10 items", () => {
    const processedStreams = Array.from({ length: 13 }, (_, i) =>
      makeItem({ id: `imp_${i}`, section: "important", urgency: "mentions", activity: i })
    )
    const resolved = resolveSections(SMART_SIDEBAR_CONFIG, makeInput({ processedStreams, getUnreadCount: () => 1 }))
    expect(resolved.find((r) => r.section.id === "important")?.items).toHaveLength(10)
  })

  it("Recent fills unreads then reads up to 5 total", () => {
    const processedStreams = [
      makeItem({ id: "u1", section: "recent", activity: 100 }),
      makeItem({ id: "u2", section: "recent", activity: 90 }),
      makeItem({ id: "r1", section: "recent", activity: 80 }),
      makeItem({ id: "r2", section: "recent", activity: 70 }),
      makeItem({ id: "r3", section: "recent", activity: 60 }),
      makeItem({ id: "r4", section: "recent", activity: 50 }),
    ]
    const getUnreadCount = unreadFrom(new Set(["u1", "u2"]))
    const recent = resolveSections(SMART_SIDEBAR_CONFIG, makeInput({ processedStreams, getUnreadCount })).find(
      (r) => r.section.id === "recent"
    )
    // 2 unreads + 3 reads = 5, dropping r4.
    expect(recent?.items.map((i) => i.id)).toEqual(["u1", "u2", "r1", "r2", "r3"])
  })

  it("Recent shows all unreads when there are 5 or more", () => {
    const processedStreams = Array.from({ length: 7 }, (_, i) =>
      makeItem({ id: `u${i}`, section: "recent", activity: 100 - i })
    )
    const getUnreadCount = () => 1
    const recent = resolveSections(SMART_SIDEBAR_CONFIG, makeInput({ processedStreams, getUnreadCount })).find(
      (r) => r.section.id === "recent"
    )
    expect(recent?.items).toHaveLength(7)
  })
})

describe("resolveSections — All preset", () => {
  it("partitions by stream type with DMs composed of real, system, then virtual", () => {
    const processedStreams = [
      makeItem({ id: "sp_2", type: StreamTypes.SCRATCHPAD, activity: 5 }),
      makeItem({ id: "sp_1", type: StreamTypes.SCRATCHPAD, activity: 10 }),
      makeItem({ id: "ch_b", type: StreamTypes.CHANNEL, slug: "beta" }),
      makeItem({ id: "ch_a", type: StreamTypes.CHANNEL, slug: "alpha" }),
      makeItem({ id: "dm_old", type: StreamTypes.DM, activity: 1 }),
      makeItem({ id: "dm_new", type: StreamTypes.DM, activity: 9 }),
      makeItem({ id: "sys_1", type: StreamTypes.SYSTEM, displayName: "System" }),
    ]
    const virtualDmStreams = [makeItem({ id: "vdm_1", type: StreamTypes.DM, activity: 0 })]

    expect(shape({ processedStreams, virtualDmStreams, getUnreadCount: () => 0 }, ALL_SIDEBAR_CONFIG)).toEqual([
      // Scratchpads by activity (most recent first).
      { id: "scratchpads", items: ["sp_1", "sp_2"] },
      // Channels alphabetically (no unreads to float).
      { id: "channels", items: ["ch_a", "ch_b"] },
      // Real DMs (activity), then system streams, then synthetic drafts.
      { id: "dms", items: ["dm_new", "dm_old", "sys_1", "vdm_1"] },
    ])
  })
})

describe("resolveSections — label sections", () => {
  const labelFirst = {
    version: SIDEBAR_CONFIG_VERSION,
    basePreset: "smart" as const,
    sections: [
      { id: labelSectionId("lbl_1"), spec: { kind: "label" as const, labelId: "lbl_1" } },
      { id: "recent", spec: { kind: "smart" as const, bucket: "recent" as const } },
    ],
    // Quick links are irrelevant to section resolution; an empty list satisfies the type.
    quickLinks: [],
  }

  it("claims labeled streams for the topmost label section, removing them from buckets below", () => {
    const processedStreams = [
      makeItem({ id: "s_old", section: "recent", activity: 1 }),
      makeItem({ id: "s_new", section: "recent", activity: 9 }),
      makeItem({ id: "s_other", section: "pinned", activity: 5 }),
    ]
    // s_new and s_other carry the label; s_old does not.
    const streamIdsByLabel = new Map([["lbl_1", new Set(["s_new", "s_other"])]])

    const result = resolveSections(labelFirst, makeInput({ processedStreams, streamIdsByLabel })).map((r) => ({
      id: r.section.id,
      items: r.items.map((i) => i.id),
    }))

    expect(result).toEqual([
      // Label lens (topmost): both labeled streams, by activity.
      { id: labelSectionId("lbl_1"), items: ["s_new", "s_other"] },
      // Recent no longer shows s_new — it was claimed by the label section above.
      { id: "recent", items: ["s_old"] },
    ])
  })

  it("keeps a stream in the bucket above and drops it from the label section below", () => {
    const recentFirst = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart" as const,
      sections: [
        { id: "recent", spec: { kind: "smart" as const, bucket: "recent" as const } },
        { id: labelSectionId("lbl_1"), spec: { kind: "label" as const, labelId: "lbl_1" } },
      ],
      quickLinks: [],
    }
    const processedStreams = [
      makeItem({ id: "s_old", section: "recent", activity: 1 }),
      makeItem({ id: "s_new", section: "recent", activity: 9 }),
      makeItem({ id: "s_other", section: "pinned", activity: 5 }),
    ]
    const streamIdsByLabel = new Map([["lbl_1", new Set(["s_new", "s_other"])]])

    const result = resolveSections(recentFirst, makeInput({ processedStreams, streamIdsByLabel })).map((r) => ({
      id: r.section.id,
      items: r.items.map((i) => i.id),
    }))

    expect(result).toEqual([
      // Recent (topmost) keeps s_new; s_old is read but within the cap.
      { id: "recent", items: ["s_new", "s_old"] },
      // Label section only keeps s_other; s_new was claimed by Recent above.
      { id: labelSectionId("lbl_1"), items: ["s_other"] },
    ])
  })

  it("resolves to an empty section when the label has no assigned streams", () => {
    const processedStreams = [makeItem({ id: "s_1", section: "recent", activity: 1 })]
    const result = resolveSections(labelFirst, makeInput({ processedStreams, streamIdsByLabel: new Map() }))
    expect(result.find((r) => r.section.id === labelSectionId("lbl_1"))?.items).toEqual([])
  })
})

describe("resolveSections — custom sections", () => {
  function customSpec(sectionId: string, streamIds: string[]) {
    return { kind: "custom" as const, sectionId, name: sectionId, streamIds }
  }

  it("trumps order: a stream filed in a custom section shows only there, even when a section above would claim it", () => {
    // Recent is ordered first and would normally claim s_new, but s_new is filed
    // into the custom section below — so it appears only in the custom section.
    const config = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart" as const,
      sections: [
        { id: "recent", spec: { kind: "smart" as const, bucket: "recent" as const } },
        { id: customSectionId("sec_1"), spec: customSpec("sec_1", ["s_new"]) },
      ],
      quickLinks: [],
    }
    const processedStreams = [
      makeItem({ id: "s_old", section: "recent", activity: 1 }),
      makeItem({ id: "s_new", section: "recent", activity: 9 }),
    ]

    const result = resolveSections(config, makeInput({ processedStreams })).map((r) => ({
      id: r.section.id,
      items: r.items.map((i) => i.id),
    }))

    expect(result).toEqual([
      { id: "recent", items: ["s_old"] },
      { id: customSectionId("sec_1"), items: ["s_new"] },
    ])
  })

  it("withholds custom-filed streams from a label lens regardless of order", () => {
    const config = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart" as const,
      sections: [
        { id: labelSectionId("lbl_1"), spec: { kind: "label" as const, labelId: "lbl_1" } },
        { id: customSectionId("sec_1"), spec: customSpec("sec_1", ["s_lab"]) },
      ],
      quickLinks: [],
    }
    const processedStreams = [
      makeItem({ id: "s_lab", section: "recent", activity: 5 }),
      makeItem({ id: "s_other", section: "recent", activity: 3 }),
    ]
    // Both streams carry the label, but s_lab is also filed into the custom section.
    const streamIdsByLabel = new Map([["lbl_1", new Set(["s_lab", "s_other"])]])

    const result = resolveSections(config, makeInput({ processedStreams, streamIdsByLabel })).map((r) => ({
      id: r.section.id,
      items: r.items.map((i) => i.id),
    }))

    expect(result).toEqual([
      // Label lens keeps only s_other; s_lab is trumped by its custom section.
      { id: labelSectionId("lbl_1"), items: ["s_other"] },
      { id: customSectionId("sec_1"), items: ["s_lab"] },
    ])
  })

  it("sorts custom members by activity and ignores ids with no matching stream", () => {
    const config = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart" as const,
      sections: [{ id: customSectionId("sec_1"), spec: customSpec("sec_1", ["a", "b", "ghost"]) }],
      quickLinks: [],
    }
    const processedStreams = [
      makeItem({ id: "a", section: "other", activity: 1 }),
      makeItem({ id: "b", section: "other", activity: 9 }),
    ]
    const custom = resolveSections(config, makeInput({ processedStreams })).find(
      (r) => r.section.id === customSectionId("sec_1")
    )
    // b (activity 9) before a (activity 1); "ghost" has no stream and is dropped.
    expect(custom?.items.map((i) => i.id)).toEqual(["b", "a"])
  })

  it("keeps a stream in only the first custom section when two list it (single membership)", () => {
    const config = {
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "smart" as const,
      sections: [
        { id: customSectionId("sec_a"), spec: customSpec("sec_a", ["s_x"]) },
        { id: customSectionId("sec_b"), spec: customSpec("sec_b", ["s_x"]) },
      ],
      quickLinks: [],
    }
    const processedStreams = [makeItem({ id: "s_x", section: "other", activity: 1 })]

    const result = resolveSections(config, makeInput({ processedStreams })).map((r) => ({
      id: r.section.id,
      items: r.items.map((i) => i.id),
    }))

    expect(result).toEqual([
      { id: customSectionId("sec_a"), items: ["s_x"] },
      { id: customSectionId("sec_b"), items: [] },
    ])
  })
})
