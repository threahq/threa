import type { ReactNode, Ref } from "react"
import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { SidePanelClose } from "@/components/ui/side-panel"
import { useInPaneDrawer, usePanel, useSidebar } from "@/contexts"
import { cn } from "@/lib/utils"
import { usePaneDragHandle } from "./pane-drop"
import { PaneFocusToggle } from "./pane-focus"
import { PanelTabStrip, usePanelCloseFocusLanding } from "./panel-tab-strip"

interface PaneHeaderProps {
  workspaceId: string
  /** Names the pane while it is dragged. */
  name: string
  /** The pane's identity, and the handle that drags it, while its section shows no tab row. */
  title?: ReactNode
  /** The title is an input being edited, so it doesn't drag. */
  editingTitle?: boolean
  /** The title has no text to truncate, so it never narrows past its icons. */
  fixedTitle?: boolean
  /** The pane's labels, riding in its tab row and folding first when the row runs short. */
  tabLabels?: ReactNode
  /** The pane's menu carries the split actions, so its tab menu doesn't repeat them. */
  splitsInPaneMenu?: boolean
  /** The pane's menu trigger, after its controls and before focus and close. */
  menu?: ReactNode
  closeLabel?: string
  /** For a pane that fits its controls to the header's room. */
  measureRefs?: { header: Ref<HTMLElement>; leading: Ref<HTMLDivElement>; trailing: Ref<HTMLDivElement> }
  /** That pane still has a control to fold, so its tab row keeps its reserve until it has. */
  canFoldControls?: boolean
  className?: string
  /** The pane's own controls, after its title. */
  children?: ReactNode
}

/**
 * A pane's header. The pane gives its title, controls and menu; the rest is the
 * pane system's: the sidebar toggle in the first column, the tab row standing
 * in for the title while the section holds several tabs, the drag handle,
 * focus, and close. A phone's pane keeps the toggle, and closes with Back when
 * it is over the route's. A pane in a drawer is the drawer's alone: no tab row,
 * drag or close.
 */
export function PaneHeader({
  workspaceId,
  name,
  title,
  editingTitle,
  fixedTitle,
  tabLabels,
  splitsInPaneMenu,
  menu,
  closeLabel,
  measureRefs,
  canFoldControls,
  className,
  children,
}: PaneHeaderProps) {
  const { tabbed: inTabbedSection, inFirstColumn, onRoute, canClosePanel, closePanel, shownPanes } = usePanel()
  const { isMobile, state: sidebarState } = useSidebar()
  const inDrawer = useInPaneDrawer()
  const tabbed = inTabbedSection && !inDrawer
  const closeRef = usePanelCloseFocusLanding()
  // A phone shows one pane at a time, so a dragged pane has nowhere to land.
  const dragHandle = usePaneDragHandle(workspaceId, name, !tabbed && !inDrawer && !isMobile && !editingTitle)

  return (
    <header
      ref={measureRefs?.header}
      className={cn("relative flex h-12 shrink-0 items-center gap-2 border-b px-4", className)}
    >
      {/* A pinned sidebar hides the toggle at no width, so the wrapper hands back the header's gap after it too. */}
      <div
        ref={measureRefs?.leading}
        className={cn(
          "flex shrink-0 items-center gap-2 transition-[margin] duration-200 ease-out empty:hidden",
          !isMobile && !inDrawer && inFirstColumn && sidebarState === "pinned" && "-mr-2"
        )}
      >
        {!inDrawer && (isMobile || inFirstColumn) && <SidebarToggle location="page" />}
        {!inDrawer && isMobile && !onRoute && (
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={closePanel} ref={closeRef}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Back</span>
          </Button>
        )}
      </div>
      {tabbed ? (
        <PanelTabStrip
          workspaceId={workspaceId}
          className="-ml-2"
          labels={tabLabels}
          splitsInPaneMenu={splitsInPaneMenu}
          canFoldControls={canFoldControls}
        />
      ) : (
        title !== undefined && (
          <div className={cn("flex flex-1 items-center gap-2", !fixedTitle && "min-w-0")} {...dragHandle}>
            {title}
          </div>
        )
      )}
      {children}
      <div ref={measureRefs?.trailing} className="flex shrink-0 items-center gap-1 empty:hidden">
        {menu}
        <PaneFocusToggle />
        {!isMobile &&
          !inDrawer &&
          (canClosePanel ? (
            <SidePanelClose onClose={closePanel} ref={closeRef} aria-label={closeLabel} />
          ) : (
            // Holds close's place beside another pane, so a pane opening later doesn't push the controls left.
            shownPanes > 1 && <span aria-hidden className="h-8 w-8 shrink-0" />
          ))}
      </div>
    </header>
  )
}
