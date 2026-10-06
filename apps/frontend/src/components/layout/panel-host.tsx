import { usePanel, isConversationPanel, PaneScope } from "@/contexts"
import { Pane } from "@/components/panes"
import { getDraftPromotionSource } from "@/lib/draft-promotions"
import { StreamPanel } from "@/components/thread"
import { ConversationPanel } from "@/components/conversations/conversation-panel"

/** A draft thread promoted to its real stream keeps the draft's key, so its pane survives the handoff. */
function panelKeyFor(workspaceId: string, panelId: string): string {
  return getDraftPromotionSource(workspaceId, panelId) ?? panelId
}

interface PanelHostProps {
  workspaceId: string
  onClose: () => void
  className?: string
}

/**
 * Picks the side panel's content by panel kind: a `conv:<id>` panel opens a
 * conversation projection (Mechanism B), every other id is a stream/thread/draft
 * handled by {@link StreamPanel}. Both stream.tsx and board.tsx host the panel
 * through this, so either surface can open either kind. Keyed on the panel id so
 * switching targets remounts cleanly — except a draft thread promoted to its real
 * stream, which keeps the draft's key so the panel carries its state across the
 * handoff instead of remounting. Hosts must not key this element themselves: an
 * outer `key={panelId}` unmounts the whole host on promotion, before the key
 * below can preserve anything.
 */
export function PanelHost({ workspaceId, onClose, className }: PanelHostProps) {
  const { panelId } = usePanel()
  if (panelId && isConversationPanel(panelId)) {
    return <ConversationPanel key={panelId} workspaceId={workspaceId} onClose={onClose} className={className} />
  }
  return (
    <StreamPanel
      key={panelId ? panelKeyFor(workspaceId, panelId) : panelId}
      workspaceId={workspaceId}
      onClose={onClose}
      className={className}
    />
  )
}

/**
 * Every open panel tab stacked in one cell: the active tab shows and the rest
 * stay mounted under it, so switching tabs keeps each one's scroll and draft.
 * Tabs are keyed the way {@link PanelHost} keys its content, so a draft
 * promoted in its tab keeps its pane.
 */
export function PanelTabStack({ workspaceId }: { workspaceId: string }) {
  const { panelIds, activePanelId } = usePanel()
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
      {panelIds.map((id) => (
        <Pane key={panelKeyFor(workspaceId, id)} column={1} covered={id !== activePanelId} data-panel-tab={id}>
          <PaneScope panelId={id}>
            <ScopedPanelHost workspaceId={workspaceId} />
          </PaneScope>
        </Pane>
      ))}
    </div>
  )
}

function ScopedPanelHost({ workspaceId }: { workspaceId: string }) {
  const { closePanel } = usePanel()
  return <PanelHost workspaceId={workspaceId} onClose={closePanel} />
}
