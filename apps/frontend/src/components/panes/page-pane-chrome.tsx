import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { usePanel, useSidebar } from "@/contexts"
import { pageTitleOf } from "@/lib/page-panes"
import { cn } from "@/lib/utils"
import { PaneHeader } from "./pane-header"

interface PagePaneHeaderProps {
  workspaceId: string
  /** The page's own way back, kept by the pane in the first column (on a phone, the route's). */
  back?: { to: string; label: string }
  icon?: ReactNode
  title?: ReactNode
  className?: string
  /** What follows the title: the page's actions, or its search field. */
  children?: ReactNode
}

/** A workspace page's way back, icon and title, in its pane's header. */
export function PagePaneHeader({ workspaceId, back, icon, title, className, children }: PagePaneHeaderProps) {
  const { panelId, inFirstColumn, onRoute } = usePanel()
  const { isMobile } = useSidebar()
  const first = isMobile ? onRoute : inFirstColumn
  const backLink = first && back && (
    <Link
      to={back.to}
      className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}
      aria-label={back.label}
    >
      <ArrowLeft className="h-4 w-4" />
    </Link>
  )

  // Back is part of the page's identity: the tab row standing in for the title stands in for it too.
  return (
    <PaneHeader
      workspaceId={workspaceId}
      name={(panelId && pageTitleOf(panelId)) ?? ""}
      title={
        title !== undefined || icon !== undefined ? (
          <>
            {backLink}
            {icon}
            {title !== undefined && <h1 className="truncate font-semibold">{title}</h1>}
          </>
        ) : undefined
      }
      fixedTitle={title === undefined}
      className={className}
    >
      {children}
    </PaneHeader>
  )
}
