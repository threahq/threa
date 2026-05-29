import type { StreamType } from "@threa/types"
import type {
  SidebarConfig,
  SidebarSection,
  SidebarSectionSpec,
  SidebarBasePreset,
  SidebarTypeSection,
  SidebarQuickLink,
  SidebarQuickLinkKey,
} from "@threa/types"
import { SMART_SIDEBAR_CONFIG, ALL_SIDEBAR_CONFIG, DEFAULT_QUICK_LINKS } from "@threa/types"
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

/** Stable section ids per stream type — match the "All" preset ids so a removed
 * type section re-added from the editor reuses its prior collapse-state key. */
const TYPE_SECTION_IDS: Record<SidebarTypeSection, string> = {
  scratchpad: "scratchpads",
  channel: "channels",
  dm: "dms",
}

/**
 * The deterministic, stable id for a section spec — one section per spec, so the
 * id doubles as the collapse-state key and as an add/remove dedup key. Matches
 * the ids hard-coded in the presets (`SMART_SIDEBAR_CONFIG` / `ALL_SIDEBAR_CONFIG`)
 * so re-adding a removed preset section restores its collapse state.
 */
export function sectionIdForSpec(spec: SidebarSectionSpec): string {
  switch (spec.kind) {
    case "smart":
      return spec.bucket
    case "type":
      return TYPE_SECTION_IDS[spec.streamType]
    case "label":
      return labelSectionId(spec.labelId)
  }
}

/** Whether a section for this spec is already in the config. */
export function hasSection(config: SidebarConfig, spec: SidebarSectionSpec): boolean {
  const id = sectionIdForSpec(spec)
  return config.sections.some((s) => sectionIdForSpec(s.spec) === id)
}

/**
 * Append a section for the spec (no-op if already present). Pure — the caller
 * persists the result via `useSidebarConfig().setConfig`.
 */
export function addSection(config: SidebarConfig, spec: SidebarSectionSpec): SidebarConfig {
  if (hasSection(config, spec)) return config
  return { ...config, sections: [...config.sections, { id: sectionIdForSpec(spec), spec }] }
}

/** Drop the section with the given id (no-op if absent). Pure. */
export function removeSection(config: SidebarConfig, sectionId: string): SidebarConfig {
  return { ...config, sections: config.sections.filter((s) => s.id !== sectionId) }
}

/**
 * Move the `activeId` section to the position of the `overId` section, shifting
 * the rest — the reorder produced by a drag-and-drop drop. Pure; no-op when
 * either id is missing or they are the same. The caller persists the result.
 */
export function moveSection(config: SidebarConfig, activeId: string, overId: string): SidebarConfig {
  if (activeId === overId) return config
  const from = config.sections.findIndex((s) => s.id === activeId)
  const to = config.sections.findIndex((s) => s.id === overId)
  if (from === -1 || to === -1) return config
  const next = [...config.sections]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return { ...config, sections: next }
}

/** Order-sensitive compare of two section lists by their specs (ids are derived). */
function sameSectionOrder(a: SidebarSection[], b: SidebarSection[]): boolean {
  return a.length === b.length && a.every((s, i) => sectionIdForSpec(s.spec) === sectionIdForSpec(b[i].spec))
}

/** Whether the quick links are in their default order and all enabled. */
function quickLinksAreDefault(links: SidebarQuickLink[]): boolean {
  return (
    links.length === DEFAULT_QUICK_LINKS.length &&
    links.every((link, i) => link.key === DEFAULT_QUICK_LINKS[i].key && link.enabled)
  )
}

/**
 * The preset this config is pristinely equal to, or `null` once the user has
 * reordered / added / removed sections or touched the quick links (a "custom"
 * layout). Drives the editor's Smart/All highlight — divergence is derived from
 * the document, not stored as a third `basePreset` value.
 */
export function isPristinePreset(config: SidebarConfig): SidebarBasePreset | null {
  if (!quickLinksAreDefault(config.quickLinks)) return null
  if (sameSectionOrder(config.sections, SMART_SIDEBAR_CONFIG.sections)) return "smart"
  if (sameSectionOrder(config.sections, ALL_SIDEBAR_CONFIG.sections)) return "all"
  return null
}

/** Toggle a quick link's visibility. Pure; no-op for an unknown key. */
export function toggleQuickLink(config: SidebarConfig, key: SidebarQuickLinkKey): SidebarConfig {
  return {
    ...config,
    quickLinks: config.quickLinks.map((link) => (link.key === key ? { ...link, enabled: !link.enabled } : link)),
  }
}

/**
 * Move the `activeKey` quick link to the position of `overKey`, shifting the
 * rest — the reorder produced by a drag-and-drop drop. Pure; no-op when either
 * key is missing or they are the same.
 */
export function moveQuickLink(config: SidebarConfig, activeKey: string, overKey: string): SidebarConfig {
  if (activeKey === overKey) return config
  const from = config.quickLinks.findIndex((link) => link.key === activeKey)
  const to = config.quickLinks.findIndex((link) => link.key === overKey)
  if (from === -1 || to === -1) return config
  const next = [...config.quickLinks]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return { ...config, quickLinks: next }
}

/**
 * Add the label section if absent, remove it if present. Pure — the caller
 * persists the result via `useSidebarConfig().setConfig`.
 */
export function toggleLabelSection(config: SidebarConfig, labelId: string): SidebarConfig {
  const spec: SidebarSectionSpec = { kind: "label", labelId }
  return hasSection(config, spec) ? removeSection(config, labelSectionId(labelId)) : addSection(config, spec)
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
