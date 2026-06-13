import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, type LucideIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
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
 * Shared header for the list pages (Saved, Activity, Scheduled): a back arrow,
 * an icon + title, and a chip-style tab strip.
 *
 * On desktop the title and the tab strip share one row (`justify-between`). On
 * mobile there isn't room for both — the non-shrinking chips would otherwise
 * swallow the title — so the header stacks into two rows: title on top, the tab
 * strip on its own full-width row below. The strip scrolls horizontally rather
 * than wrapping, so adding tabs never pushes the title off-screen.
 */
export function PageHeaderTabs({ backTo, icon: Icon, title, value, tabs, actions }: PageHeaderTabsProps) {
  return (
    <header className="flex flex-col gap-2 border-b px-4 py-2 sm:h-12 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:py-0">
      <div className="flex items-center gap-2 min-w-0">
        <SidebarToggle location="page" />
        <Link
          to={backTo}
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}
          aria-label="Back to workspace"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
          <h1 className="font-semibold truncate">{title}</h1>
        </div>
      </div>

      <div className="flex items-center gap-2 min-w-0 sm:min-w-fit sm:shrink-0">
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
    </header>
  )
}
