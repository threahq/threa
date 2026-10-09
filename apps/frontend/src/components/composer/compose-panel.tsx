import { useContext, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { SidePanel, SidePanelTitle, SidePanelContent } from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { PaneFocusContext, PaneHeader, PanelTabTitle, useProvideComposeSlot } from "@/components/panes"
import { createComposePanelId, usePanel, useRevealReady } from "@/contexts"
import { cn } from "@/lib/utils"

interface ComposePanelProps {
  workspaceId: string
  streamId: string
  className?: string
}

/**
 * A stream's draft, written in a pane of its own (`compose:<streamId>`). The
 * stream's composer renders into this pane, so it is the same draft, with the
 * same attachments and send, as the one it replaces inline.
 */
export function ComposePanel({ workspaceId, streamId, className }: ComposePanelProps) {
  const { getPanelUrl } = usePanel()
  const paneFocus = useContext(PaneFocusContext)
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const slot = useMemo(() => (node ? { node, paneFocus } : null), [node, paneFocus])
  const composing = useProvideComposeSlot(streamId, slot)
  // The composer portals in from its stream's pane, which the reveal already waits on.
  useRevealReady(true)

  return (
    <SidePanel className={className} data-editor-zone="panel">
      <PaneHeader
        workspaceId={workspaceId}
        name="Draft"
        title={
          <SidePanelTitle>
            <PanelTabTitle workspaceId={workspaceId} panelId={createComposePanelId(streamId)} />
          </SidePanelTitle>
        }
      />
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
