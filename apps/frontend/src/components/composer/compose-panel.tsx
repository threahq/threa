import { useContext, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ChevronLeft } from "lucide-react"
import {
  SidePanel,
  SidePanelHeader,
  SidePanelTitle,
  SidePanelClose,
  SidePanelContent,
} from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  PaneFocusContext,
  PaneFocusToggle,
  PanelTabStrip,
  PanelTabTitle,
  usePanelCloseFocusLanding,
  useProvideComposeSlot,
} from "@/components/panes"
import { SidebarToggle } from "@/components/layout"
import { parseComposePanel, usePanel, useSidebar } from "@/contexts"

interface ComposePanelProps {
  workspaceId: string
  onClose: () => void
  className?: string
}

/**
 * A stream's draft, written in a pane of its own (`compose:<streamId>`). The
 * stream's composer renders into this pane, so it is the same draft, with the
 * same attachments and send, as the one it replaces inline.
 */
export function ComposePanel({ workspaceId, onClose, className }: ComposePanelProps) {
  const { panelId, tabbed, getPanelUrl } = usePanel()
  const streamId = (panelId && parseComposePanel(panelId)) ?? ""
  const paneFocus = useContext(PaneFocusContext)
  const { isMobile } = useSidebar()
  const closeRef = usePanelCloseFocusLanding()
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const slot = useMemo(() => (node ? { node, paneFocus } : null), [node, paneFocus])
  const composing = useProvideComposeSlot(streamId, slot)

  return (
    <SidePanel className={className} data-editor-zone="panel">
      <SidePanelHeader className="relative">
        {isMobile && <SidebarToggle location="page" />}
        {isMobile && (
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} ref={closeRef}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Back</span>
          </Button>
        )}
        {tabbed ? (
          <PanelTabStrip workspaceId={workspaceId} className={isMobile ? undefined : "-ml-2"} />
        ) : (
          <SidePanelTitle className="min-w-0 flex-1 truncate">
            {panelId && <PanelTabTitle workspaceId={workspaceId} panelId={panelId} />}
          </SidePanelTitle>
        )}
        <PaneFocusToggle />
        {!isMobile && !tabbed && <SidePanelClose onClose={onClose} ref={closeRef} />}
      </SidePanelHeader>
      <SidePanelContent className="relative flex flex-col">
        <div ref={setNode} className="flex min-h-0 flex-1 flex-col" hidden={!composing} />
        {!composing && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>This draft's stream isn't open</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" asChild>
                <Link to={getPanelUrl(streamId)}>Open stream</Link>
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </SidePanelContent>
    </SidePanel>
  )
}
