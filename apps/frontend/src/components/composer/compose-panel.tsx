import { useContext, useMemo, useState } from "react"
import { Link } from "react-router-dom"
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
  PhonePaneLeading,
  PhonePaneSwitcher,
  usePanelCloseFocusLanding,
  usePhoneHeaderSwipe,
  useProvideComposeSlot,
} from "@/components/panes"
import { createComposePanelId, usePanel, useSidebar } from "@/contexts"
import { cn } from "@/lib/utils"

interface ComposePanelProps {
  workspaceId: string
  streamId: string
  onClose: () => void
  className?: string
}

/**
 * A stream's draft, written in a pane of its own (`compose:<streamId>`). The
 * stream's composer renders into this pane, so it is the same draft, with the
 * same attachments and send, as the one it replaces inline.
 */
export function ComposePanel({ workspaceId, streamId, onClose, className }: ComposePanelProps) {
  const { tabbed, getPanelUrl } = usePanel()
  const paneFocus = useContext(PaneFocusContext)
  const { isMobile } = useSidebar()
  const closeRef = usePanelCloseFocusLanding()
  const headerSwipe = usePhoneHeaderSwipe()
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const slot = useMemo(() => (node ? { node, paneFocus } : null), [node, paneFocus])
  const composing = useProvideComposeSlot(streamId, slot)

  return (
    <SidePanel className={className} data-editor-zone="panel">
      <SidePanelHeader className="relative" {...headerSwipe}>
        {isMobile && <PhonePaneLeading onBack={onClose} backRef={closeRef} />}
        {tabbed ? (
          <PanelTabStrip workspaceId={workspaceId} className="-ml-2" />
        ) : (
          <SidePanelTitle className="min-w-0 flex-1 truncate">
            <PanelTabTitle workspaceId={workspaceId} panelId={createComposePanelId(streamId)} />
          </SidePanelTitle>
        )}
        <PaneFocusToggle />
        <PhonePaneSwitcher workspaceId={workspaceId} />
        {!isMobile && !tabbed && <SidePanelClose onClose={onClose} ref={closeRef} />}
      </SidePanelHeader>
      <SidePanelContent className="relative flex flex-col">
        <div ref={setNode} className={cn("flex min-h-0 flex-1 flex-col", !composing && "hidden")} />
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
