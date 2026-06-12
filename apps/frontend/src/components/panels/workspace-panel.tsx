import { useState, type ReactNode } from "react"
import { ChevronLeft, MoreHorizontal } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  SidePanel,
  SidePanelHeader,
  SidePanelTitle,
  SidePanelClose,
  SidePanelContent,
} from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import {
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
} from "@/components/layout/sidebar/sidebar-actions"
import { useSidebar } from "@/contexts"
import { usePanelInstance } from "@/contexts/panel-instance-context"
import { usePanelStandardActions } from "./use-panel-standard-actions"

interface WorkspacePanelProps {
  panelId: string
  title: ReactNode
  icon?: LucideIcon
  /** Content-specific menu actions; panel-management actions are appended. */
  actions?: SidebarActionItem[]
  onClose: () => void
  children: ReactNode
}

/**
 * Shared chrome for view panels: draggable header with title, injectable
 * action menu (content actions first, panel management appended), and a
 * close button. Stream/thread panels render their own header (breadcrumbs,
 * labels) but share the same primitives and standard actions.
 */
export function WorkspacePanel({ panelId, title, icon: Icon, actions = [], onClose, children }: WorkspacePanelProps) {
  const { isMobile } = useSidebar()
  const { dragHandleProps } = usePanelInstance()
  const standardActions = usePanelStandardActions(panelId)
  const [isMenuDrawerOpen, setIsMenuDrawerOpen] = useState(false)

  const menuActions = [...actions, ...(isMobile ? [] : standardActions)]

  return (
    <SidePanel>
      <SidePanelHeader className="relative select-none" {...(!isMobile ? dragHandleProps : {})}>
        {isMobile && (
          <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Back</span>
          </Button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <SidePanelTitle>{title}</SidePanelTitle>
        </div>
        {menuActions.length > 0 &&
          (isMobile ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 flex-shrink-0"
                aria-label="Panel actions"
                onClick={() => setIsMenuDrawerOpen(true)}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              <SidebarActionDrawer
                open={isMenuDrawerOpen}
                onOpenChange={setIsMenuDrawerOpen}
                actions={menuActions}
                title="Panel actions"
                description="Choose an action for this panel."
              />
            </>
          ) : (
            <SidebarActionMenu
              actions={menuActions}
              ariaLabel="Panel actions"
              trigger={
                <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" aria-label="Panel actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              }
            />
          ))}
        {!isMobile && <SidePanelClose onClose={onClose} />}
      </SidePanelHeader>
      <SidePanelContent className="flex flex-col">{children}</SidePanelContent>
    </SidePanel>
  )
}
