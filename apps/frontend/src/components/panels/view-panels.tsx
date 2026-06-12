import { Bookmark, Bell } from "lucide-react"
import { SAVED_STATUSES, type SavedStatus } from "@threa/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SavedTabs, SavedList } from "@/pages/saved"
import { ActivityTabs, ActivityList, MarkAllActivityReadButton, type ActivityFilter } from "@/pages/activity"
import { usePanelNavigation } from "@/contexts/panel-instance-context"
import { WorkspacePanel } from "./workspace-panel"
import { createViewPanelId } from "./panel-locations"

/**
 * Side-panel renderings of the routed view surfaces. Each one reuses the
 * page's tab strip and list, with tab navigation rewritten to replace this
 * panel's id in the URL (`view:saved` → `view:saved:done`) so the sub-view
 * survives refresh and sharing exactly like the routed page does (INV-59).
 */

interface ViewPanelProps {
  panelId: string
  workspaceId: string
  subView: string | null
  onClose: () => void
}

const VALID_SAVED_TABS = new Set<string>(SAVED_STATUSES)

export function SavedViewPanel({ panelId, workspaceId, subView, onClose }: ViewPanelProps) {
  const { getPanelUrl } = usePanelNavigation()
  const tab: SavedStatus = subView && VALID_SAVED_TABS.has(subView) ? (subView as SavedStatus) : "saved"
  const tabHref = (next: SavedStatus) => getPanelUrl(createViewPanelId("saved", next === "saved" ? null : next))

  return (
    <WorkspacePanel panelId={panelId} title="Saved" icon={Bookmark} onClose={onClose}>
      <div className="flex h-10 items-center border-b px-3">
        <SavedTabs value={tab} tabHref={tabHref} />
      </div>
      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <div className="py-1">
          <SavedList workspaceId={workspaceId} tab={tab} />
        </div>
      </ScrollArea>
    </WorkspacePanel>
  )
}

const VALID_ACTIVITY_FILTERS = new Set<string>(["all", "unread", "me"])

export function ActivityViewPanel({ panelId, workspaceId, subView, onClose }: ViewPanelProps) {
  const { getPanelUrl } = usePanelNavigation()
  const filter: ActivityFilter = subView && VALID_ACTIVITY_FILTERS.has(subView) ? (subView as ActivityFilter) : "all"
  const filterHref = (next: ActivityFilter) => getPanelUrl(createViewPanelId("activity", next === "all" ? null : next))

  return (
    <WorkspacePanel panelId={panelId} title="Activity" icon={Bell} onClose={onClose}>
      <div className="flex h-10 items-center justify-between gap-2 border-b px-3">
        <ActivityTabs value={filter} filterHref={filterHref} />
        <MarkAllActivityReadButton workspaceId={workspaceId} />
      </div>
      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <div className="py-2">
          <ActivityList workspaceId={workspaceId} filter={filter} />
        </div>
      </ScrollArea>
    </WorkspacePanel>
  )
}
