import type { StreamWithPreview, SidebarSectionKey } from "@threahq/types"

export type UrgencyLevel = "mentions" | "ai" | "bot" | "activity" | "quiet"

/** Sorting strategies for sidebar sections */
export type SortType = "activity" | "importance"

/**
 * Smart-view bucket a stream is categorized into. The canonical list of keys
 * lives in `@threahq/types` (`SIDEBAR_SECTION_KEYS`) since it's also the persisted
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
  /**
   * True when the stream's composer holds an unsent draft that is loaded (not
   * stashed) — the user stepped away without sending or stashing. Computed once
   * in the sidebar builder and read by the row to show a draft hint, mirroring
   * `nameDecrypting`.
   */
  hasLoadedDraft?: boolean
  /**
   * Set by `resolveSections` when this thread row nests under its root stream's
   * row: the root's id. Rows carrying it always directly follow their root (or a
   * sibling) in a section's items.
   */
  treeParentId?: string
  /**
   * Set by `resolveSections` on a read thread an automatic section still lists
   * only because the viewer hasn't cleared it (`heldThreadIds`). The row dims
   * and offers Clear.
   */
  held?: boolean
}
