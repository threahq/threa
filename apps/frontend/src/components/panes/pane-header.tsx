import type { ReactNode, Ref } from "react"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { SidePanelClose } from "@/components/ui/side-panel"
import { useInPaneDrawer, usePanel, useSidebar } from "@/contexts"
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
  /** The title is an input being edited, so it doesn't drag. */
  editingTitle?: boolean
  /** The pane's labels, riding in its tab row and folding first when the row runs short. */
  tabLabels?: ReactNode
  /** The pane's menu carries the split actions, so its tab menu doesn't repeat them. */
  splitsInPaneMenu?: boolean
  /** The pane's menu trigger, after its controls and before focus and close. */
  menu?: ReactNode
  closeLabel?: string
  /** For a pane that fits its controls to the header's room. */
  measureRefs?: { header: Ref<HTMLElement>; leading: Ref<HTMLDivElement>; trailing: Ref<HTMLDivElement> }
  className?: string
  /** The pane's own controls, after its title. */
  children?: ReactNode
}

/**
 * A pane's header. The pane gives its title, controls and menu; the rest is the
 * pane system's: the sidebar toggle in the first column or Back on a phone, the
 * tab row standing in for the title while the section holds several tabs, the
 * drag handle, focus, the phone's pane switcher, and close. A pane in a drawer
 * is the drawer's alone: no tab row, drag or close.
 */
export function PaneHeader({
  workspaceId,
  name,
  title,
  editingTitle,
  tabLabels,
  splitsInPaneMenu,
  menu,
  closeLabel,
  measureRefs,
  className,
  children,
}: PaneHeaderProps) {
  const { tabbed: inTabbedSection, inFirstColumn, canClosePanel, closePanel } = usePanel()
  const { isMobile, state: sidebarState } = useSidebar()
  const inDrawer = useInPaneDrawer()
  const tabbed = inTabbedSection && !inDrawer
  const closeRef = usePanelCloseFocusLanding()
  const swipe = usePhoneHeaderSwipe()
  // A phone shows one pane at a time, so a dragged pane has nowhere to land.
  const dragHandle = usePaneDragHandle(workspaceId, name, !tabbed && !inDrawer && !isMobile && !editingTitle)

  return (
    <header
      ref={measureRefs?.header}
      className={cn("relative flex h-12 shrink-0 items-center gap-2 border-b px-4", className)}
      {...swipe}
    >
      {/* A pinned sidebar hides the toggle at no width, so the wrapper hands back the header's gap after it too. */}
      <div
        ref={measureRefs?.leading}
        className={cn(
          "flex shrink-0 items-center gap-2 transition-[margin] duration-200 ease-out empty:hidden",
          !isMobile && !inDrawer && inFirstColumn && sidebarState === "pinned" && "-mr-2"
        )}
      >
        {!inDrawer &&
          (isMobile ? (
            <PhonePaneLeading onBack={closePanel} backRef={closeRef} />
          ) : (
            inFirstColumn && <SidebarToggle location="page" />
          ))}
      </div>
      {tabbed ? (
        <PanelTabStrip
          workspaceId={workspaceId}
          className="-ml-2"
          labels={tabLabels}
          splitsInPaneMenu={splitsInPaneMenu}
        />
      ) : (
        title !== undefined && (
          <div className="flex min-w-0 flex-1 items-center gap-2" {...dragHandle}>
            {title}
          </div>
        )
      )}
      {children}
      <div ref={measureRefs?.trailing} className="flex shrink-0 items-center gap-1 empty:hidden">
        <PhonePaneSwitcher workspaceId={workspaceId} />
        {menu}
        <PaneFocusToggle />
        {!isMobile && !tabbed && !inDrawer && canClosePanel && (
          <SidePanelClose onClose={closePanel} ref={closeRef} aria-label={closeLabel} />
        )}
      </div>
    </header>
  )
}
