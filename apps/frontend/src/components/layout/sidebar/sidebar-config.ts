import type { StreamType } from "@threa/types"
import type { CollapseState, ViewMode } from "@/contexts"
import { SMART_SECTIONS } from "./config"
import type { SectionKey } from "./types"

/**
 * The sidebar is an ordered list of typed **sections**. Each section's `spec`
 * declares which streams it draws from; presentation (label, collapse style,
 * preview behavior) is derived from the spec at render time.
 *
 * Today the two view-mode presets (Smart / All) are the only shapes a config
 * can take. Persistence and a user-editable order land in a later step — this
 * module exists so rendering is already driven by a config object rather than a
 * `viewMode` branch.
 */
export type SidebarSectionSpec =
  | { kind: "smart"; bucket: SectionKey }
  | { kind: "type"; streamType: Extract<StreamType, "scratchpad" | "channel" | "dm"> }

export interface SidebarSection {
  /** Stable key — also the collapse-state persistence key (see SidebarProvider). */
  id: string
  spec: SidebarSectionSpec
}

export type SidebarBasePreset = "smart" | "all"

export interface SidebarConfig {
  basePreset: SidebarBasePreset
  sections: SidebarSection[]
}

/** How a resolved section renders. Derived purely from its spec. */
export interface SectionPresentation {
  label: string
  icon?: string
  /** Tiered sections show a "N more" expander; binary sections are open/collapsed only. */
  tiered: boolean
  compact: boolean
  showPreviewOnHover: boolean
  /** Sections that vanish entirely when they hold no streams. */
  hideWhenEmpty: boolean
  /** Collapse state before the user has toggled this section. */
  defaultCollapse: CollapseState
}

/** Presentation for the "All" view's stream-type sections. */
const TYPE_PRESENTATION: Record<Extract<StreamType, "scratchpad" | "channel" | "dm">, SectionPresentation> = {
  scratchpad: {
    label: "Scratchpads",
    tiered: true,
    compact: true,
    showPreviewOnHover: true,
    hideWhenEmpty: false,
    defaultCollapse: "open",
  },
  channel: {
    label: "Channels",
    tiered: true,
    compact: true,
    showPreviewOnHover: true,
    hideWhenEmpty: false,
    defaultCollapse: "open",
  },
  dm: {
    label: "Direct Messages",
    tiered: true,
    compact: true,
    showPreviewOnHover: true,
    hideWhenEmpty: true,
    defaultCollapse: "open",
  },
}

/** Resolve how a section should render from its spec. */
export function sectionPresentation(spec: SidebarSectionSpec): SectionPresentation {
  if (spec.kind === "type") return TYPE_PRESENTATION[spec.streamType]

  const config = SMART_SECTIONS[spec.bucket]
  return {
    label: config.label,
    icon: config.icon,
    // Important / Recent / Pinned are simple binary sections; "Everything Else"
    // gets the tiered "N more" reveal for its long quiet tail.
    tiered: spec.bucket === "other",
    compact: config.compact,
    showPreviewOnHover: config.showPreviewOnHover,
    hideWhenEmpty: true,
    defaultCollapse: spec.bucket === "other" ? "collapsed" : "open",
  }
}

/** Section ids double as collapse-state keys, so they must match prior keys. */
export const SMART_PRESET: SidebarConfig = {
  basePreset: "smart",
  sections: [
    { id: "important", spec: { kind: "smart", bucket: "important" } },
    { id: "recent", spec: { kind: "smart", bucket: "recent" } },
    { id: "pinned", spec: { kind: "smart", bucket: "pinned" } },
    { id: "other", spec: { kind: "smart", bucket: "other" } },
  ],
}

export const ALL_PRESET: SidebarConfig = {
  basePreset: "all",
  sections: [
    { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
    { id: "channels", spec: { kind: "type", streamType: "channel" } },
    { id: "dms", spec: { kind: "type", streamType: "dm" } },
  ],
}

export function presetForViewMode(viewMode: ViewMode): SidebarConfig {
  return viewMode === "all" ? ALL_PRESET : SMART_PRESET
}
