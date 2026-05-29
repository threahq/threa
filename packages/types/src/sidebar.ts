/**
 * Sidebar configuration — the wire contract for a user's per-workspace sidebar
 * layout. The frontend renders from this object (see
 * `apps/frontend/src/components/layout/sidebar/sidebar-config.ts`, which adds
 * the purely-presentational labels/icons/collapse behavior on top); the backend
 * persists it per (workspace, user) and broadcasts changes for cross-device sync.
 *
 * The two presets below are the only shapes a config takes today. A
 * user-editable order and label-driven sections land in later steps — this
 * module exists so the persisted shape is the full document, not a `smart|all`
 * flag that a richer editor would have to migrate away from.
 */

/** Smart-view buckets a stream can be sorted into. */
export const SIDEBAR_SECTION_KEYS = ["important", "recent", "pinned", "other"] as const
export type SidebarSectionKey = (typeof SIDEBAR_SECTION_KEYS)[number]

/** Stream types that can back a type-driven section ("All" view). */
export const SIDEBAR_TYPE_SECTIONS = ["scratchpad", "channel", "dm"] as const
export type SidebarTypeSection = (typeof SIDEBAR_TYPE_SECTIONS)[number]

/** What streams a section draws from. Presentation is derived from this at render time. */
export type SidebarSectionSpec =
  | { kind: "smart"; bucket: SidebarSectionKey }
  | { kind: "type"; streamType: SidebarTypeSection }

export interface SidebarSection {
  /** Stable key — also the collapse-state persistence key on the frontend. */
  id: string
  spec: SidebarSectionSpec
}

export const SIDEBAR_BASE_PRESETS = ["smart", "all"] as const
export type SidebarBasePreset = (typeof SIDEBAR_BASE_PRESETS)[number]

export interface SidebarConfig {
  basePreset: SidebarBasePreset
  sections: SidebarSection[]
}

/** Section ids double as collapse-state keys, so they must stay stable. */
export const SMART_SIDEBAR_CONFIG: SidebarConfig = {
  basePreset: "smart",
  sections: [
    { id: "important", spec: { kind: "smart", bucket: "important" } },
    { id: "recent", spec: { kind: "smart", bucket: "recent" } },
    { id: "pinned", spec: { kind: "smart", bucket: "pinned" } },
    { id: "other", spec: { kind: "smart", bucket: "other" } },
  ],
}

export const ALL_SIDEBAR_CONFIG: SidebarConfig = {
  basePreset: "all",
  sections: [
    { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
    { id: "channels", spec: { kind: "type", streamType: "channel" } },
    { id: "dms", spec: { kind: "type", streamType: "dm" } },
  ],
}

export function sidebarConfigForPreset(preset: SidebarBasePreset): SidebarConfig {
  return preset === "all" ? ALL_SIDEBAR_CONFIG : SMART_SIDEBAR_CONFIG
}

/** Seeded for users who have never customized their sidebar. */
export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = SMART_SIDEBAR_CONFIG
