import { cn } from "@/lib/utils"
import { newAsideDraftScope } from "@/lib/drafts/aside-scope"
import { ASIDE_LABEL, ASIDE_PANE_HEAD } from "./aside-chrome"
import { AsideDraftTabs } from "./aside-draft-tabs"
import { AsideDraftEditor } from "./aside-draft-editor"
import { useAsideDrafts } from "./use-aside-drafts"
import type { AsideDraftSurface } from "./use-aside-draft-surface"

interface AsideDraftsProps {
  workspaceId: string
  asideId: string
  surface: AsideDraftSurface
  className?: string
}

/**
 * What you are writing here, as opposed to what you are saying to Ariadne.
 * Closed it is one strip naming every draft; open it is the writing surface,
 * with the strip still in its head so switching drafts costs one click and
 * never leaves the aside.
 */
export function AsideDrafts({ workspaceId, asideId, surface, className }: AsideDraftsProps) {
  const drafts = useAsideDrafts(workspaceId, asideId)
  const open = surface.openScope
  const tabs = (
    <AsideDraftTabs
      drafts={drafts}
      openScope={open}
      onOpen={surface.openDraft}
      onNew={() => surface.openDraft(newAsideDraftScope(asideId))}
    />
  )

  return (
    <section
      data-testid="aside-drafts"
      data-open={open ? "true" : undefined}
      className={cn("flex min-h-0 flex-col", className)}
    >
      {open ? (
        <AsideDraftEditor
          key={open}
          workspaceId={workspaceId}
          scope={open}
          tabs={tabs}
          onClose={surface.closeDraft}
          onSendToComposer={surface.sendToComposer}
          pendingAgentBlocks={surface.pendingAgentBlocks}
          onPendingAgentBlocksConsumed={surface.consumePendingAgentBlocks}
        />
      ) : (
        // Closed, the strip IS the region: its own divider would double up
        // against the one the region already draws against the conversation.
        <div className={cn(ASIDE_PANE_HEAD, "border-b-0")}>
          <span className={ASIDE_LABEL}>Drafts</span>
          {tabs}
        </div>
      )}
    </section>
  )
}
