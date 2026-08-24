import { cn } from "@/lib/utils"
import { newAsideDraftScope } from "@/lib/drafts/aside-scope"
import { ASIDE_LABEL, ASIDE_TRAY } from "./aside-chrome"
import { AsideDraftStrip } from "./aside-draft-strip"
import { AsideDraftEditor } from "./aside-draft-editor"
import { useAsideDrafts, useDeleteAsideDraft } from "./use-aside-drafts"
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
  const deleteDraft = useDeleteAsideDraft(workspaceId)
  const open = surface.openScope
  const strip = (
    <AsideDraftStrip
      drafts={drafts}
      openScope={open}
      onOpen={surface.openDraft}
      onNew={() => surface.openDraft(newAsideDraftScope(asideId))}
      onDelete={(scope) => {
        // Closing first: the editor's teardown flush would otherwise re-save
        // the draft it is holding, moments after the row was deleted.
        if (scope === open) surface.closeDraft()
        void deleteDraft(scope)
      }}
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
          strip={strip}
          onClose={surface.closeDraft}
          onSendToComposer={surface.sendToComposer}
          pendingAgentBlocks={surface.pendingAgentBlocks}
          onPendingAgentBlocksConsumed={surface.consumePendingAgentBlocks}
        />
      ) : (
        <div className={ASIDE_TRAY}>
          <span className={cn(ASIDE_LABEL, "mt-2 shrink-0")}>Drafts</span>
          {strip}
        </div>
      )}
    </section>
  )
}
