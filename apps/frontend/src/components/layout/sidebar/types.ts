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
   * the row renders a loader instead of the placeholder. Resolved once by the
   * sidebar builder off the shared name cache + session (see
   * `resolveSealedNamePending`), not per row.
   */
  nameDecrypting?: boolean
}
