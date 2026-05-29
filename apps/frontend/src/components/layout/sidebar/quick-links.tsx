import { Bell, Bookmark, Brain, CalendarClock, FileEdit, Paperclip, Tag } from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { Link } from "react-router-dom"
import { UnreadBadge } from "@/components/unread-badge"
import { useSidebar } from "@/contexts"
import { cn } from "@/lib/utils"
import { SectionHeader } from "./sections"

interface SidebarQuickLinksProps {
  workspaceId: string
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
  key: string
  to: string
  icon: ComponentType<{ className?: string }>
  label: string
  isActive: boolean
  unreadCount: number
  signalSlot: ReactNode
}

const SECTION_KEY = "quick-links"
const DEFAULT_STATE = "open"

export function SidebarQuickLinks({
  workspaceId,
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

  const items: QuickLinkItem[] = [
    {
      key: "drafts",
      to: `/w/${workspaceId}/drafts`,
      icon: FileEdit,
      label: "Drafts",
      isActive: isDraftsPage,
      unreadCount: draftCount,
      signalSlot: draftCount > 0 ? <span className="ml-auto text-xs text-muted-foreground">({draftCount})</span> : null,
    },
    {
      key: "saved",
      to: `/w/${workspaceId}/saved`,
      icon: Bookmark,
      label: "Saved",
      isActive: isSavedPage,
      unreadCount: savedCount,
      signalSlot: savedCount > 0 ? <span className="ml-auto text-xs text-muted-foreground">({savedCount})</span> : null,
    },
    {
      key: "files",
      to: `/w/${workspaceId}/files`,
      icon: Paperclip,
      label: "Files",
      isActive: isFilesPage,
      unreadCount: 0,
      signalSlot: null,
    },
    {
      key: "scheduled",
      to: `/w/${workspaceId}/scheduled`,
      icon: CalendarClock,
      label: "Scheduled",
      isActive: isScheduledPage,
      unreadCount: scheduledCount,
      signalSlot:
        scheduledCount > 0 ? <span className="ml-auto text-xs text-muted-foreground">({scheduledCount})</span> : null,
    },
    {
      key: "memory",
      to: `/w/${workspaceId}/memory`,
      icon: Brain,
      label: "Memory",
      isActive: isMemoryPage,
      unreadCount: 0,
      signalSlot: null,
    },
    {
      key: "labels",
      to: `/w/${workspaceId}/labels`,
      icon: Tag,
      label: "Labels",
      isActive: isLabelsPage,
      unreadCount: 0,
      signalSlot: null,
    },
    {
      key: "activity",
      to: `/w/${workspaceId}/activity`,
      icon: Bell,
      label: "Activity",
      isActive: isActivityPage,
      unreadCount: unreadActivityCount,
      signalSlot: unreadActivityCount > 0 ? <UnreadBadge count={unreadActivityCount} className="ml-auto" /> : null,
    },
  ]

  // Aggregate only "real" attention-worthy signals — drafts and saved counts
  // are persistent artifacts, not unread activity. The activity feed is the
  // only source of new-attention signal in the quick links today.
  const unreadAggregate = unreadActivityCount

  const isOpen = state === "open"

  return (
    <div className="space-y-1">
      <SectionHeader
        label="Quick Links"
        state={state}
        onToggle={() => toggleSectionState(SECTION_KEY, DEFAULT_STATE)}
        unreadAggregate={unreadAggregate}
      />

      {isOpen &&
        items.map(({ key, to, icon: Icon, label, isActive, unreadCount, signalSlot }) => (
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
        ))}
    </div>
  )
}
