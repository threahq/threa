import type { ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import type { LucideIcon } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PagePaneHeader } from "@/components/panes/page-pane-chrome"
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
 * On desktop the title and the tab strip share one row. On a phone there isn't
 * room for both — the non-shrinking chips would otherwise swallow the title —
 * so the strip gets its own full-width row below. The strip scrolls
 * horizontally rather than wrapping, so adding tabs never pushes the title
 * off-screen.
 */
export function PageHeaderTabs({ backTo, icon: Icon, title, value, tabs, actions }: PageHeaderTabsProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const isMobile = useIsMobile()
  const controls = (
    <div className={cn("flex min-w-0 items-center gap-2", isMobile ? "justify-center" : "shrink-0")}>
      <div className="min-w-0 overflow-x-auto scrollbar-none">
        <Tabs value={value}>
          <TabsList className="h-8 w-max">
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
      {actions}
    </div>
  )

  return (
    <>
      <PagePaneHeader
        workspaceId={workspaceId!}
        back={{ to: backTo, label: "Back to workspace" }}
        icon={<Icon className="h-5 w-5 shrink-0 text-muted-foreground" />}
        title={title}
        className={cn(isMobile && "border-b-0")}
      >
        {!isMobile && controls}
      </PagePaneHeader>
      {isMobile && <div className="border-b px-4 pb-2">{controls}</div>}
    </>
  )
}
