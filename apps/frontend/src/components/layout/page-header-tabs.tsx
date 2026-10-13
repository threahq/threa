import type { ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import type { LucideIcon } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PagePaneHeader, usePageHeaderFit } from "@/components/panes/page-pane-chrome"
import { useMeasuredWidth } from "@/hooks/use-element-width"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

export interface PageHeaderTab {
  /** Matches the active `value` to drive the selected styling. */
  value: string
  label: string
  /** Destination URL — tabs are navigation, so each trigger renders an <a> (INV-40). */
  href: string
  /** Optional trailing adornment (e.g. an unread count pill). */
  badge?: ReactNode
}

interface PageHeaderTabsProps {
  /** Back-arrow destination (the workspace home). */
  backTo: string
  icon: LucideIcon
  title: string
  /** The active tab's `value`. */
  value: string
  tabs: PageHeaderTab[]
  /** Optional right-aligned actions (e.g. a "Mark all read" button). */
  actions?: ReactNode
}

/**
 * Shared header for the list pages (Saved, Activity, Scheduled, Streams): the
 * page pane's header with an icon + title and a chip-style tab strip.
 *
 * The title and the tab strip share one row while the pane has room for both.
 * On a phone, and in a pane too narrow for them — the non-shrinking chips
 * would otherwise swallow the title — the strip gets its own full-width row
 * below. The strip scrolls horizontally rather than wrapping, so adding tabs
 * never pushes the title off-screen.
 */
export function PageHeaderTabs({ backTo, icon: Icon, title, value, tabs, actions }: PageHeaderTabsProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const isMobile = useIsMobile()
  const [listRef, listWidth] = useMeasuredWidth<HTMLDivElement>()
  const [actionsRef, actionsWidth] = useMeasuredWidth<HTMLDivElement>()
  const { fits, measureRefs } = usePageHeaderFit(listWidth + (actionsWidth > 0 ? actionsWidth + 8 : 0))
  const stacked = isMobile || !fits
  const controls = (
    <div className={cn("flex min-w-0 items-center gap-2", stacked && "justify-center")}>
      <div className="min-w-0 overflow-x-auto scrollbar-none">
        <Tabs value={value}>
          <TabsList ref={listRef} className="h-8 w-max">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} asChild>
                <Link to={t.href} className="text-xs px-2.5 py-1">
                  {t.label}
                  {t.badge}
                </Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div ref={actionsRef} className="shrink-0 empty:hidden">
        {actions}
      </div>
    </div>
  )

  return (
    <>
      <PagePaneHeader
        workspaceId={workspaceId!}
        back={{ to: backTo, label: "Back to workspace" }}
        icon={<Icon className="h-5 w-5 shrink-0 text-muted-foreground" />}
        title={title}
        measureRefs={measureRefs}
        canFoldControls={!stacked}
        className={cn(stacked && "border-b-0")}
      >
        {!stacked && controls}
      </PagePaneHeader>
      {stacked && <div className="border-b px-4 pb-2">{controls}</div>}
    </>
  )
}
