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
  /**
   * True while this stream's sealed E2E name is still decrypting on cold load, so
   * the row renders a loader instead of the placeholder. The sidebar builder wires
   * the single authority once (`useSealedNamePendingResolver`) and applies it per
   * row, so the leaf reads this as plain data without touching the session.
   */
  nameDecrypting?: boolean
}
