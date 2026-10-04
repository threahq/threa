import {
  Bell,
  Bookmark,
  Brain,
  CalendarClock,
  Compass,
  FileEdit,
  ListChecks,
  Paperclip,
  Tag,
  type LucideIcon,
} from "lucide-react"
import type { SidebarQuickLinkKey } from "@threahq/types"

/**
 * Per-key label + icon for the quick links. Single source of truth shared by the
 * rendered list, the sidebar editor (which lists every link for reorder /
 * show-hide) and `app:` chip names, so they never drift.
 */
export const QUICK_LINK_META: Record<SidebarQuickLinkKey, { label: string; icon: LucideIcon }> = {
  drafts: { label: "Drafts", icon: FileEdit },
  saved: { label: "Saved", icon: Bookmark },
  streams: { label: "Streams", icon: Compass },
  files: { label: "Files", icon: Paperclip },
  scheduled: { label: "Scheduled", icon: CalendarClock },
  agenda: { label: "Agent agenda", icon: ListChecks },
  memory: { label: "Memory", icon: Brain },
  labels: { label: "Labels", icon: Tag },
  activity: { label: "Activity", icon: Bell },
}
