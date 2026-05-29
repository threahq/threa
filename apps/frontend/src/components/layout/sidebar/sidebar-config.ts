import type { StreamType } from "@threa/types"
import type { SidebarConfig, SidebarSection, SidebarSectionSpec, SidebarBasePreset } from "@threa/types"
import type { CollapseState } from "@/contexts"
import { SMART_SECTIONS } from "./config"

/**
 * The sidebar renders an ordered list of typed **sections** described by a
 * {@link SidebarConfig} (the persisted wire contract lives in `@threa/types`).
 * This module adds the purely-presentational layer on top: how each section's
 * `spec` maps to a label, icon, and collapse behavior at render time.
 */
export type { SidebarConfig, SidebarSection, SidebarSectionSpec, SidebarBasePreset }

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
