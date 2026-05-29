import { Bell, Bookmark, Brain, CalendarClock, FileEdit, Paperclip, Tag, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import type { SidebarQuickLink, SidebarQuickLinkKey } from "@threa/types"
import { QUICK_LINKS_SECTION_ID } from "@threa/types"
import { UnreadBadge } from "@/components/unread-badge"
import { useSidebar } from "@/contexts"
import { cn } from "@/lib/utils"
import { SectionHeader } from "./sections"

/**
 * Per-key label + icon for the quick links. Single source of truth shared by the
 * rendered list and the sidebar editor (which lists every link for reorder /
 * show-hide), so the two never drift.
 */
export const QUICK_LINK_META: Record<SidebarQuickLinkKey, { label: string; icon: LucideIcon }> = {
  drafts: { label: "Drafts", icon: FileEdit },
  saved: { label: "Saved", icon: Bookmark },
  files: { label: "Files", icon: Paperclip },
  scheduled: { label: "Scheduled", icon: CalendarClock },
  memory: { label: "Memory", icon: Brain },
  labels: { label: "Labels", icon: Tag },
  activity: { label: "Activity", icon: Bell },
}

interface SidebarQuickLinksProps {
  workspaceId: string
  /** The viewer's quick-link layout (order + visibility) from their sidebar config. */
  quickLinks: SidebarQuickLink[]
  isDraftsPage: boolean
  draftCount: number
  isSavedPage: boolean
  savedCount: number
  isScheduledPage: boolean
  scheduledCount: number
  isActivityPage: boolean
  isMemoryPage: boolean
  isFilesPage: boolean
  isLabelsPage: boolean
  unreadActivityCount: number
}

interface QuickLinkItem {
  to: string
  isActive: boolean
  unreadCount: number
  signalSlot: ReactNode
}

// Collapse-state key for the block; also its section id in the config, so the
// editor's quick-links section and this rendered block share one stable key.
const SECTION_KEY = QUICK_LINKS_SECTION_ID
const DEFAULT_STATE = "open"

function countSlot(count: number): ReactNode {
  return count > 0 ? <span className="ml-auto text-xs text-muted-foreground">({count})</span> : null
}

export function SidebarQuickLinks({
  workspaceId,
  quickLinks,
  isDraftsPage,
  draftCount,
  isSavedPage,
  savedCount,
  isScheduledPage,
  scheduledCount,
  isActivityPage,
  isMemoryPage,
  isFilesPage,
  isLabelsPage,
  unreadActivityCount,
}: SidebarQuickLinksProps) {
  const { collapseOnMobile, getSectionState, toggleSectionState } = useSidebar()
  const state = getSectionState(SECTION_KEY, DEFAULT_STATE)

  // The route/count signal data per key; presentation (label/icon) comes from
  // QUICK_LINK_META so the editor and the list stay in sync.
  const itemByKey: Record<SidebarQuickLinkKey, QuickLinkItem> = {
    drafts: {
      to: `/w/${workspaceId}/drafts`,
      isActive: isDraftsPage,
      unreadCount: draftCount,
      signalSlot: countSlot(draftCount),
    },
    saved: {
      to: `/w/${workspaceId}/saved`,
      isActive: isSavedPage,
      unreadCount: savedCount,
      signalSlot: countSlot(savedCount),
    },
    files: { to: `/w/${workspaceId}/files`, isActive: isFilesPage, unreadCount: 0, signalSlot: null },
    scheduled: {
      to: `/w/${workspaceId}/scheduled`,
      isActive: isScheduledPage,
      unreadCount: scheduledCount,
      signalSlot: countSlot(scheduledCount),
    },
    memory: { to: `/w/${workspaceId}/memory`, isActive: isMemoryPage, unreadCount: 0, signalSlot: null },
    labels: { to: `/w/${workspaceId}/labels`, isActive: isLabelsPage, unreadCount: 0, signalSlot: null },
    activity: {
      to: `/w/${workspaceId}/activity`,
      isActive: isActivityPage,
      unreadCount: unreadActivityCount,
      signalSlot: unreadActivityCount > 0 ? <UnreadBadge count={unreadActivityCount} className="ml-auto" /> : null,
    },
  }

  // A link renders when it's set to "show", or "show when active" and it
  // currently carries a signal (a count / unread badge). "hidden" never renders.
  const isVisible = (link: SidebarQuickLink): boolean => {
    if (link.visibility === "show") return true
    if (link.visibility === "active") return itemByKey[link.key].unreadCount > 0
    return false
  }
  const visible = quickLinks.filter(isVisible)

  // Aggregate only "real" attention-worthy signals — drafts and saved counts
  // are persistent artifacts, not unread activity. The activity feed is the
  // only source of new-attention signal in the quick links today, and only when
  // the viewer actually keeps it visible.
  const activityVisible = visible.some((link) => link.key === "activity")
  const unreadAggregate = activityVisible ? unreadActivityCount : 0

  const isOpen = state === "open"

  // Every link can be hidden from the editor; render nothing when none remain.
  if (visible.length === 0) return null

  return (
    <div className="space-y-1">
      <SectionHeader
        label="Quick Links"
        state={state}
        onToggle={() => toggleSectionState(SECTION_KEY, DEFAULT_STATE)}
        unreadAggregate={unreadAggregate}
      />

      {isOpen &&
        visible.map(({ key }) => {
          const { label, icon: Icon } = QUICK_LINK_META[key]
          const { to, isActive, unreadCount, signalSlot } = itemByKey[key]
          return (
            <Link
              key={key}
              to={to}
              onClick={collapseOnMobile}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                isActive ? "bg-primary/10" : "hover:bg-muted/50",
                !isActive && unreadCount === 0 && "text-muted-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
              {signalSlot}
            </Link>
          )
        })}
    </div>
  )
}
