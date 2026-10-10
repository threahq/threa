import type { ReactNode } from "react"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { SidePanelClose } from "@/components/ui/side-panel"
import { usePanel, usePhonePanes } from "@/contexts"
import { cn } from "@/lib/utils"
import { usePaneDragHandle } from "./pane-drop"
import { PaneFocusToggle } from "./pane-focus"
import { PanelTabStrip, usePanelCloseFocusLanding } from "./panel-tab-strip"
import { PhonePaneLeading, PhonePaneSwitcher, usePhoneHeaderSwipe } from "./phone-pane-header"

interface PaneHeaderProps {
  workspaceId: string
  /** Names the pane while it is dragged. */
  name: string
  /** The pane's identity, and the handle that drags it, while its section shows no tab row. */
  title?: ReactNode
  className?: string
  /** The pane's own controls, after its title. */
  children?: ReactNode
}

/**
 * A pane's header. The pane gives its title and controls; the rest is the pane
 * system's: the sidebar toggle in the first column or Back on a phone, the tab
 * row standing in for the title while the section holds several tabs, focus,
 * the phone's pane switcher, and close.
 */
export function PaneHeader({ workspaceId, name, title, className, children }: PaneHeaderProps) {
  const { tabbed, inFirstColumn, canClosePanel, closePanel } = usePanel()
  const phone = usePhonePanes()
  const closeRef = usePanelCloseFocusLanding()
  const swipe = usePhoneHeaderSwipe()
  const dragHandle = usePaneDragHandle(workspaceId, name, !tabbed)

  return (
    <header className={cn("relative flex h-12 shrink-0 items-center gap-2 border-b px-4", className)} {...swipe}>
      {phone ? (
        <PhonePaneLeading onBack={closePanel} backRef={closeRef} />
      ) : (
        inFirstColumn && <SidebarToggle location="page" />
      )}
      {tabbed ? (
        <PanelTabStrip workspaceId={workspaceId} className="-ml-2" />
      ) : (
        title !== undefined && (
          <div className="flex min-w-0 flex-1 items-center gap-2" {...dragHandle}>
            {title}
          </div>
        )
      )}
      {children}
      <PaneFocusToggle />
      <PhonePaneSwitcher workspaceId={workspaceId} />
      {!phone && !tabbed && canClosePanel && <SidePanelClose onClose={closePanel} ref={closeRef} />}
    </header>
  )
}
