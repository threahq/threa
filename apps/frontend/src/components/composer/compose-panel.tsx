import { useContext, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { SidePanel, SidePanelTitle, SidePanelContent } from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { PaneFocusContext, PaneHeader, PanelTabTitle, useProvideComposeSlot } from "@/components/panes"
import { createComposePanelId, createConversationPanelId, usePanel, useRevealReady } from "@/contexts"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"
import { panelIdsOf } from "@/lib/panel-tabs"
import { cn } from "@/lib/utils"

interface ComposePanelProps {
  workspaceId: string
  draftKey: string
  className?: string
}

/** Where the composer owning `draftKey` lives, to open when no composer writes the draft. */
function draftHome(draftKey: string): { title: string; label: string; panelId: string } {
  const board = parseBoardDraftKey(draftKey)
  if (board?.kind === "reply") {
    return {
      title: "This draft's conversation isn't open",
      label: "Open conversation",
      panelId: createConversationPanelId(board.conversationId),
    }
  }
  if (board) return { title: "This draft's board card isn't open", label: "Open board", panelId: "page:board" }
  return { title: "This draft's stream isn't open", label: "Open stream", panelId: draftKey }
}

/**
 * A draft, written in a pane of its own (`compose:<draftKey>`). The composer
 * owning the draft renders into this pane, so it is the same draft, with the
 * same attachments and send, as the one it replaces inline.
 */
export function ComposePanel({ workspaceId, draftKey, className }: ComposePanelProps) {
  const { getPanelUrl, layout, closeTab } = usePanel()
  const paneFocus = useContext(PaneFocusContext)
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const slot = useMemo(() => (node ? { node, paneFocus } : null), [node, paneFocus])
  const composing = useProvideComposeSlot(draftKey, slot)
  // The composer portals in from the pane it lives in, which the reveal already waits on.
  useRevealReady(true)
  const home = draftHome(draftKey)
  // A board draft whose home is already open has its card scrolled away or collapsed: closing the pane puts the draft back on it.
  const homeOpen = parseBoardDraftKey(draftKey) !== null && panelIdsOf(layout).includes(home.panelId)

  return (
    <SidePanel className={className} data-editor-zone="panel">
      <PaneHeader
        workspaceId={workspaceId}
        name="Draft"
        title={
          <SidePanelTitle>
            <PanelTabTitle workspaceId={workspaceId} panelId={createComposePanelId(draftKey)} />
          </SidePanelTitle>
        }
      />
      <SidePanelContent className="relative flex flex-col">
        <div ref={setNode} className={cn("flex min-h-0 flex-1 flex-col", !composing && "hidden")} />
        {!composing && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{homeOpen ? "This draft's card isn't on screen" : home.title}</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              {homeOpen ? (
                <Button variant="outline" size="sm" onClick={() => closeTab(createComposePanelId(draftKey))}>
                  Write on its card
                </Button>
              ) : (
                <Button variant="outline" size="sm" asChild>
                  <Link to={getPanelUrl(home.panelId)}>{home.label}</Link>
                </Button>
              )}
            </EmptyContent>
          </Empty>
        )}
      </SidePanelContent>
    </SidePanel>
  )
}
