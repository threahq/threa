import { usePanel, isConversationPanel } from "@/contexts"
import { StreamPanel } from "@/components/thread"
import { ConversationPanel } from "@/components/conversations/conversation-panel"

interface PanelHostProps {
  workspaceId: string
  onClose: () => void
}

/**
 * Picks the side panel's content by panel kind: a `conv:<id>` panel opens a
 * conversation projection (Mechanism B), every other id is a stream/thread/draft
 * handled by {@link StreamPanel}. Both stream.tsx and board.tsx host the panel
 * through this, so either surface can open either kind. Keyed on the panel id so
 * switching targets remounts cleanly.
 */
export function PanelHost({ workspaceId, onClose }: PanelHostProps) {
  const { panelId } = usePanel()
  if (panelId && isConversationPanel(panelId)) {
    return <ConversationPanel key={panelId} workspaceId={workspaceId} onClose={onClose} />
  }
  return <StreamPanel key={panelId} workspaceId={workspaceId} onClose={onClose} />
}
