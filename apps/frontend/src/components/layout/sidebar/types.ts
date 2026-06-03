import type { StreamWithPreview, SidebarSectionKey } from "@threa/types"

export type UrgencyLevel = "mentions" | "ai" | "bot" | "activity" | "quiet"

/** Sorting strategies for sidebar sections */
export type SortType = "activity" | "importance" | "alphabetic_active_first"

/**
 * Smart-view bucket a stream is categorized into. The canonical list of keys
 * lives in `@threa/types` (`SIDEBAR_SECTION_KEYS`) since it's also the persisted
 * wire shape; this is the same domain value, so we derive from it rather than
 * re-declaring the literal union and risking drift.
 */
export type SectionKey = SidebarSectionKey

export interface StreamItemData extends StreamWithPreview {
  urgency: UrgencyLevel
  section: SectionKey
  dmPeerUserId?: string
  /** Whether the viewer has pinned this stream (drives the Pinned section + action label). */
  isPinned?: boolean
}
