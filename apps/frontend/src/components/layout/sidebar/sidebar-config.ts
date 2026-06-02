import type { StreamType } from "@threa/types"
import type {
  SidebarConfig,
  SidebarSection,
  SidebarSectionSpec,
  SidebarBasePreset,
  SidebarTypeSection,
  SidebarQuickLink,
  SidebarQuickLinkKey,
  SidebarQuickLinkVisibility,
} from "@threa/types"
import {
  SMART_SIDEBAR_CONFIG,
  ALL_SIDEBAR_CONFIG,
  DEFAULT_QUICK_LINKS,
  QUICK_LINKS_SECTION_ID,
  quickLinkHasActiveState,
} from "@threa/types"
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

/**
 * Section id for a custom section. Derived from the spec's own `sectionId` (a
 * generated uuid) so it doubles as the collapse-state key and dnd sortable id.
 */
export function customSectionId(sectionId: string): string {
  return `custom:${sectionId}`
}

/** Mint a fresh id for a new custom section. Config-local, not a domain entity. */
export function newCustomSectionId(): string {
  return crypto.randomUUID()
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
    case "custom":
      return customSectionId(spec.sectionId)
    case "quicklinks":
      return QUICK_LINKS_SECTION_ID
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

/**
 * Insert a section for the spec at `index` (clamped to the list bounds), the
 * drop produced by dragging an item out of the Add tray onto a position. No-op
 * if the spec is already present. Pure; the caller persists the result.
 */
export function addSectionAt(config: SidebarConfig, spec: SidebarSectionSpec, index: number): SidebarConfig {
  if (hasSection(config, spec)) return config
  const at = Math.max(0, Math.min(index, config.sections.length))
  const next = [...config.sections]
  next.splice(at, 0, { id: sectionIdForSpec(spec), spec })
  return { ...config, sections: next }
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

/** Whether the quick links are in their default order and all shown. */
function quickLinksAreDefault(links: SidebarQuickLink[]): boolean {
  return (
    links.length === DEFAULT_QUICK_LINKS.length &&
    links.every((link, i) => link.key === DEFAULT_QUICK_LINKS[i].key && link.visibility === "show")
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

/**
 * Set a quick link's visibility. Pure; no-op for an unknown key. An `active`
 * value on a link without a live signal is coerced to `show` (so callers can't
 * persist a meaningless state — mirrors `normalizeSidebarConfig`).
 */
export function setQuickLinkVisibility(
  config: SidebarConfig,
  key: SidebarQuickLinkKey,
  visibility: SidebarQuickLinkVisibility
): SidebarConfig {
  const next = visibility === "active" && !quickLinkHasActiveState(key) ? "show" : visibility
  return {
    ...config,
    quickLinks: config.quickLinks.map((link) => (link.key === key ? { ...link, visibility: next } : link)),
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

/** A custom section's spec, narrowed for callers that only handle this kind. */
export type CustomSectionSpec = Extract<SidebarSectionSpec, { kind: "custom" }>

/** The custom sections in the layout, in order. The picker/editor list these. */
export function customSections(config: SidebarConfig): CustomSectionSpec[] {
  return config.sections.flatMap((s) => (s.spec.kind === "custom" ? [s.spec] : []))
}

/**
 * Append a new, empty custom section with the given name. Pure — the caller
 * mints the id (so this stays testable) and persists the result. The name is
 * trimmed; an all-whitespace name is rejected (returns the config unchanged).
 */
export function createCustomSection(config: SidebarConfig, sectionId: string, name: string): SidebarConfig {
  const trimmed = name.trim()
  if (!trimmed) return config
  const spec: CustomSectionSpec = { kind: "custom", sectionId, name: trimmed, streamIds: [] }
  return { ...config, sections: [...config.sections, { id: customSectionId(sectionId), spec }] }
}

/** Rename a custom section. Pure; no-op for an unknown id or a blank name. */
export function renameCustomSection(config: SidebarConfig, sectionId: string, name: string): SidebarConfig {
  const trimmed = name.trim()
  if (!trimmed) return config
  let changed = false
  const sections = config.sections.map((section) => {
    if (section.spec.kind !== "custom" || section.spec.sectionId !== sectionId) return section
    if (section.spec.name === trimmed) return section
    changed = true
    return { ...section, spec: { ...section.spec, name: trimmed } }
  })
  // Unknown id or a no-op rename returns the original object so the caller's
  // identity check skips a needless persist + resubscribe.
  return changed ? { ...config, sections } : config
}

/** The id of the custom section a stream is filed under, or `null` if none. */
export function getStreamCustomSectionId(config: SidebarConfig, streamId: string): string | null {
  for (const s of config.sections) {
    if (s.spec.kind === "custom" && s.spec.streamIds.includes(streamId)) return s.spec.sectionId
  }
  return null
}

/**
 * File a stream into a single custom section (or remove it from all when
 * `sectionId` is null). Membership is exclusive — the stream is first removed
 * from every custom section, then appended to the target — so a stream lives in
 * at most one custom section. Pure; the caller persists the result.
 */
export function setStreamCustomSection(
  config: SidebarConfig,
  streamId: string,
  sectionId: string | null
): SidebarConfig {
  // A non-null target that no longer exists (e.g. the section was removed on
  // another device between render and drop) must not silently unfile the
  // stream from wherever it currently lives — treat it as a no-op.
  const targetExists =
    sectionId === null ||
    config.sections.some((section) => section.spec.kind === "custom" && section.spec.sectionId === sectionId)
  if (!targetExists) return config

  let changed = false
  const sections = config.sections.map((section) => {
    const spec = section.spec
    if (spec.kind !== "custom") return section
    const without = spec.streamIds.filter((id) => id !== streamId)
    const next = spec.sectionId === sectionId ? [...without, streamId] : without
    // Preserve referential identity when nothing changed (avoids needless churn).
    if (next.length === spec.streamIds.length && next.every((id, i) => id === spec.streamIds[i])) return section
    changed = true
    return { ...section, spec: { ...spec, streamIds: next } }
  })
  return changed ? { ...config, sections } : config
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

/**
 * Presentation for the Quick Links block. Rendered by its own component (a list
 * of links, not streams), so most fields are inert here; `label` names it for
 * the editor and accessibility. Never hidden when "empty" — the quick-links
 * component decides its own visibility from per-link state.
 */
const QUICK_LINKS_PRESENTATION: SectionPresentation = {
  label: "Quick Links",
  tiered: false,
  compact: false,
  showPreviewOnHover: false,
  hideWhenEmpty: false,
  defaultCollapse: "open",
}

/**
 * Presentation for a custom section. The user named it deliberately, so it stays
 * visible when empty — both as a reminder it exists and as a drop target. Tiered
 * so a large hand-curated set doesn't flood the sidebar. `label` carries the
 * user's name (the spec owns it, unlike labels whose name is resolved at render).
 */
function customSectionPresentation(name: string): SectionPresentation {
  return {
    label: name,
    tiered: true,
    compact: true,
    showPreviewOnHover: true,
    hideWhenEmpty: false,
    defaultCollapse: "open",
  }
}

/** Resolve how a section should render from its spec. */
export function sectionPresentation(spec: SidebarSectionSpec): SectionPresentation {
  if (spec.kind === "type") return TYPE_PRESENTATION[spec.streamType]
  if (spec.kind === "label") return LABEL_PRESENTATION
  if (spec.kind === "custom") return customSectionPresentation(spec.name)
  if (spec.kind === "quicklinks") return QUICK_LINKS_PRESENTATION

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
