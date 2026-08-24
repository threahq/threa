import { useMemo } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { closeAside } from "@/stores/aside-store"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { StreamTypes } from "@threa/types"
import { AsideAnchorLine } from "./aside-anchor-line"
import { AsideConversation } from "./aside-conversation"
import { AsideDraftEditor } from "./aside-draft-editor"
import { AsideDraftTray } from "./aside-drafts"
import { AsideGlyph, AsidePrivateBadge } from "./aside-chrome"
import { useAsideDrafts } from "./use-aside-drafts"
import { useAsideDraftSurface } from "./use-aside-draft-surface"

interface AsidePaneProps {
  workspaceId: string
  asideId: string
  /** The stream the aside sits beside — the hand-off's destination. */
  hostStreamId: string
  /** The draft scope a hand-off files into (`OpenAsideState.originScope`). */
  originScope: string
}

/**
 * The aside on a phone: one thing at a time, under its own header. Either the
 * conversation with Ariadne — the drafts folded into a tray above it — or one
 * draft, open for writing, with the whole sheet to itself.
 *
 * Not both: a phone sheet split between a draft and a timeline gives each half
 * a few lines and a keyboard takes what is left, so neither is usable. The
 * stage stacks them side by side because it has the room to; this doesn't.
 */
export function AsidePane({ workspaceId, asideId, hostStreamId, originScope }: AsidePaneProps) {
  const draftSurface = useAsideDraftSurface({ workspaceId, asideId, hostStreamId, originScope })
  const streams = useWorkspaceStreams(workspaceId)
  const drafts = useAsideDrafts(workspaceId, asideId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  const open = draftSurface.openScope

  return (
    <div
      data-testid="aside-pane"
      data-aside-id={asideId}
      data-editor-zone="aside"
      data-view={open ? "draft" : "chat"}
      className="flex h-full min-h-0 flex-col border-t-2 border-primary/70 bg-card"
    >
      <TooltipProvider delayDuration={300}>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b pl-3 pr-1.5">
          <AsideGlyph className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{title}</h2>
          <AsidePrivateBadge />
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label="Close aside"
            onClick={closeAside}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>
      </TooltipProvider>
      {open ? (
        <AsideDraftEditor
          key={open}
          takeover
          workspaceId={workspaceId}
          scope={open}
          title={drafts.find((draft) => draft.scope === open)?.preview}
          onClose={draftSurface.closeDraft}
          onSendToComposer={draftSurface.sendToComposer}
          pendingAgentBlocks={draftSurface.pendingAgentBlocks}
          onPendingAgentBlocksConsumed={draftSurface.consumePendingAgentBlocks}
        />
      ) : (
        <>
          <AsideAnchorLine workspaceId={workspaceId} hostStreamId={hostStreamId} anchorId={aside?.parentAnchorId} />
          <AsideDraftTray workspaceId={workspaceId} asideId={asideId} surface={draftSurface} className="border-b" />
          <div className="relative min-h-0 flex-1">
            <AsideConversation
              workspaceId={workspaceId}
              asideId={asideId}
              aside={aside}
              autoFocus={false}
              onInsertAgentBlock={draftSurface.insertAgentBlock}
            />
          </div>
        </>
      )}
    </div>
  )
}
