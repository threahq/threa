import type { NavigateFunction } from "react-router-dom"
import type { StreamMember, User } from "@threa/types"
import type { UrgencyLevel } from "@/components/layout/sidebar/types"
import type { useWorkspaceStreams } from "@/stores/workspace-store"

/** Stream type as returned by the workspace store (includes lastMessagePreview) */
export type WorkspaceStream = ReturnType<typeof useWorkspaceStreams>[number]

export interface QuickSwitcherItem {
  id: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  avatarUrl?: string
  description?: string
  group?: string
  href?: string
  onSelect: () => void
  /** Optional action button (e.g., delete) */
  onAction?: () => void
  /** Icon for the action button */
  actionIcon?: React.ComponentType<{ className?: string }>
  /** Aria label for the action button */
  actionLabel?: string
  /**
   * Row context menu, rendered in the trailing slot in place of the single
   * action button. Its clicks never navigate the row.
   */
  contextMenu?: React.ReactNode
  /** Touch long-press on the row (e.g. open the row's action drawer). */
  onLongPress?: () => void
  /** Urgency level for visual indicators (color strip, bold text) */
  urgency?: UrgencyLevel
  /** Number of unread messages */
  unreadCount?: number
  /** Number of mentions */
  mentionCount?: number
}

export interface ModeContext {
  workspaceId: string
  query: string
  onQueryChange: (query: string) => void
  navigate: NavigateFunction
  closeDialog: () => void
  streams: WorkspaceStream[]
  streamMemberships: StreamMember[]
  users?: User[]
  currentUserId?: string | null
  dmPeers?: Array<{ userId: string; streamId: string }>
}

export interface ModeResult {
  items: QuickSwitcherItem[]
  isLoading?: boolean
  emptyMessage?: string
  header?: React.ReactNode
  /** True when filter select picker is open (for Escape handling) */
  isFilterSelectActive?: boolean
  /** Close the filter select picker */
  closeFilterSelect?: () => void
}
