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
  /**
   * A label lens: streams the viewer can see that carry this label. Additive —
   * a labeled stream still appears in its smart/type section too. The label's
   * name/color/emoji are resolved from the labels cache at render time, not
   * stored here (only the id, so a renamed/recolored label stays in sync).
   */
  | { kind: "label"; labelId: string }

export interface SidebarSection {
  /** Stable key — also the collapse-state persistence key on the frontend. */
  id: string
  spec: SidebarSectionSpec
}

export const SIDEBAR_BASE_PRESETS = ["smart", "all"] as const
export type SidebarBasePreset = (typeof SIDEBAR_BASE_PRESETS)[number]

/**
 * Quick-link destinations in the sidebar's "Quick Links" group. The user can
 * reorder them and hide ones they don't use; the set itself is fixed (these are
 * the workspace's standing views).
 */
export const SIDEBAR_QUICK_LINKS = ["drafts", "saved", "files", "scheduled", "memory", "labels", "activity"] as const
export type SidebarQuickLinkKey = (typeof SIDEBAR_QUICK_LINKS)[number]

/**
 * A quick link's placement: array position is its order; `enabled` is its
 * visibility. Hidden links stay in the list (so the editor can show and
 * re-enable them, preserving their position) rather than being removed.
 */
export interface SidebarQuickLink {
  key: SidebarQuickLinkKey
  enabled: boolean
}

/** All quick links, enabled, in canonical order — the preset/seed default. */
export const DEFAULT_QUICK_LINKS: SidebarQuickLink[] = SIDEBAR_QUICK_LINKS.map((key) => ({ key, enabled: true }))

export interface SidebarConfig {
  basePreset: SidebarBasePreset
  sections: SidebarSection[]
  quickLinks: SidebarQuickLink[]
}

/**
 * Ensure a config carries a complete, deduped `quickLinks` list. Documents
 * persisted before quick links were configurable (and any partial list) get the
 * missing keys appended (enabled) in canonical order, and unknown keys dropped —
 * so every destination stays reachable and a future new link shows up for
 * existing users. Idempotent; safe to apply on every read/write.
 */
export function normalizeSidebarConfig(config: SidebarConfig): SidebarConfig {
  const seen = new Set<SidebarQuickLinkKey>()
  const quickLinks: SidebarQuickLink[] = []
  for (const link of config.quickLinks ?? []) {
    if (SIDEBAR_QUICK_LINKS.includes(link.key) && !seen.has(link.key)) {
      seen.add(link.key)
      quickLinks.push({ key: link.key, enabled: link.enabled })
    }
  }
  for (const key of SIDEBAR_QUICK_LINKS) {
    if (!seen.has(key)) quickLinks.push({ key, enabled: true })
  }
  return { ...config, quickLinks }
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
  quickLinks: DEFAULT_QUICK_LINKS,
}

export const ALL_SIDEBAR_CONFIG: SidebarConfig = {
  basePreset: "all",
  sections: [
    { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
    { id: "channels", spec: { kind: "type", streamType: "channel" } },
    { id: "dms", spec: { kind: "type", streamType: "dm" } },
  ],
  quickLinks: DEFAULT_QUICK_LINKS,
}

export function sidebarConfigForPreset(preset: SidebarBasePreset): SidebarConfig {
  return preset === "all" ? ALL_SIDEBAR_CONFIG : SMART_SIDEBAR_CONFIG
}

/** Seeded for users who have never customized their sidebar. */
export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = SMART_SIDEBAR_CONFIG
