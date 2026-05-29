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

/**
 * Section id for a label lens. Deterministic (one section per label) so the
 * toggle below is idempotent and the id doubles as the collapse-state key.
 */
export function labelSectionId(labelId: string): string {
  return `label:${labelId}`
}

/** Whether the config already pins the given label as a sidebar section. */
export function hasLabelSection(config: SidebarConfig, labelId: string): boolean {
  return config.sections.some((s) => s.spec.kind === "label" && s.spec.labelId === labelId)
}

/**
 * Add the label section if absent, remove it if present. New sections append to
 * the end (reordering is a later editor concern). Pure — the caller persists
 * the result via `useSidebarConfig().setConfig`.
 */
export function toggleLabelSection(config: SidebarConfig, labelId: string): SidebarConfig {
  if (hasLabelSection(config, labelId)) {
    return {
      ...config,
      sections: config.sections.filter((s) => !(s.spec.kind === "label" && s.spec.labelId === labelId)),
    }
  }
  return {
    ...config,
    sections: [...config.sections, { id: labelSectionId(labelId), spec: { kind: "label", labelId } }],
  }
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

/**
 * Presentation for a label section. The header is rendered as a tinted
 * `LabelChip` from the labels cache (the spec only carries the id), so `label`
 * here is just an accessibility/fallback string the caller overrides. Tiered so
 * a heavily-used label doesn't flood the sidebar; kept visible when empty since
 * the user deliberately pinned it.
 */
const LABEL_PRESENTATION: SectionPresentation = {
  label: "",
  tiered: true,
  compact: true,
  showPreviewOnHover: true,
  hideWhenEmpty: false,
  defaultCollapse: "open",
}

/** Resolve how a section should render from its spec. */
export function sectionPresentation(spec: SidebarSectionSpec): SectionPresentation {
  if (spec.kind === "type") return TYPE_PRESENTATION[spec.streamType]
  if (spec.kind === "label") return LABEL_PRESENTATION

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
