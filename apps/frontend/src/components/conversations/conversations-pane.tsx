import {
  SidePanel,
  SidePanelClose,
  SidePanelContent,
  SidePanelHeader,
  SidePanelTitle,
} from "@/components/ui/side-panel"
import {
  PaneFocusToggle,
  PanelTabStrip,
  PanelTabTitle,
  PhonePaneLeading,
  PhonePaneSwitcher,
  usePaneDragHandle,
  usePanelCloseFocusLanding,
  usePhoneHeaderSwipe,
} from "@/components/panes"
import { createConversationsPanelId, usePanel, useSidebar } from "@/contexts"
import { ConversationList } from "./conversation-list"

interface ConversationsPaneProps {
  workspaceId: string
  streamId: string
  onClose: () => void
  className?: string
}

/** A stream's conversations list as a pane of its own (`convs:<streamId>`), beside the stream it lists. */
export function ConversationsPane({ workspaceId, streamId, onClose, className }: ConversationsPaneProps) {
  const { tabbed, canClosePanel } = usePanel()
  const { isMobile } = useSidebar()
  const closeRef = usePanelCloseFocusLanding()
  const dragHandle = usePaneDragHandle(workspaceId, "Conversations", !tabbed)
  const headerSwipe = usePhoneHeaderSwipe()

  return (
    <SidePanel className={className} data-editor-zone="panel" role="region" aria-label="Conversations">
      <SidePanelHeader className="relative" {...headerSwipe}>
        {isMobile && <PhonePaneLeading onBack={onClose} backRef={closeRef} />}
        {tabbed ? (
          <PanelTabStrip workspaceId={workspaceId} className="-ml-2" />
        ) : (
          <SidePanelTitle className="min-w-0 flex-1 truncate" {...dragHandle}>
            <PanelTabTitle workspaceId={workspaceId} panelId={createConversationsPanelId(streamId)} />
          </SidePanelTitle>
        )}
        <PaneFocusToggle />
        <PhonePaneSwitcher workspaceId={workspaceId} />
        {!isMobile && !tabbed && canClosePanel && <SidePanelClose onClose={onClose} ref={closeRef} />}
      </SidePanelHeader>
      <SidePanelContent>
        <div className="h-full overflow-y-auto">
          <ConversationList workspaceId={workspaceId} streamId={streamId} />
        </div>
      </SidePanelContent>
    </SidePanel>
  )
}
