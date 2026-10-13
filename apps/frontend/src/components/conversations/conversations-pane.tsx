import { SidePanel, SidePanelContent, SidePanelTitle } from "@/components/ui/side-panel"
import { PaneHeader, PanelTabTitle } from "@/components/panes"
import { createConversationsPanelId } from "@/contexts"
import { ConversationList } from "./conversation-list"

interface ConversationsPaneProps {
  workspaceId: string
  streamId: string
  className?: string
}

/** A stream's conversations list as a pane of its own (`convs:<streamId>`), beside the stream it lists. */
export function ConversationsPane({ workspaceId, streamId, className }: ConversationsPaneProps) {
  return (
    <SidePanel className={className} data-editor-zone="panel" role="region" aria-label="Conversations">
      <PaneHeader
        workspaceId={workspaceId}
        name="Conversations"
        title={
          <SidePanelTitle>
            <PanelTabTitle workspaceId={workspaceId} panelId={createConversationsPanelId(streamId)} />
          </SidePanelTitle>
        }
      />
      <SidePanelContent>
        <div className="h-full [scrollbar-gutter:stable] overflow-y-auto">
          <ConversationList workspaceId={workspaceId} streamId={streamId} />
        </div>
      </SidePanelContent>
    </SidePanel>
  )
}
