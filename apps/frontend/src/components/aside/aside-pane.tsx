import { useCallback, useMemo, useState } from "react"
import { Eye, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StreamContent } from "@/components/timeline"
import { AgentBlockProvider, type AgentBlockData } from "@/components/timeline/agent-block-context"
import { StreamErrorBoundary } from "@/components/stream-error-boundary"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { closeAside, setAsideSurface, type AsideSurface } from "@/stores/aside-store"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { StreamTypes } from "@threa/types"
import { useCallDocked } from "./use-call-docked"
import { AsideSurfacePicker } from "./aside-surface-picker"
import { AsideAnchorLine } from "./aside-anchor-line"
import { AsideDraftDock } from "./aside-draft-dock"
import { AsideDraftEditor } from "./aside-draft-editor"
import { newAsideDraftScope } from "@/lib/drafts/aside-scope"
import { useAsideHandoff } from "@/hooks/use-aside-handoff"
import type { AsideDraftHandoff } from "@/hooks/use-aside-draft-actions"

interface AsidePaneProps {
  workspaceId: string
  asideId: string
  /** The stream the aside sits beside — the hand-off's destination. */
  hostStreamId: string
  /** The draft scope a hand-off files into (`OpenAsideState.originScope`). */
  originScope: string
  surface: Exclude<AsideSurface, "minimized">
  /** Phone-width takeover: no surface picker, the close control is the way out. */
  takeover?: boolean
}

/**
 * The aside's chat: the companion timeline against the aside stream (it IS a
 * companion stream with Ariadne — the same `StreamContent` a scratchpad or a
 * thread panel mounts), under a gold hairline that marks the private surface.
 */
export function AsidePane({
  workspaceId,
  asideId,
  hostStreamId,
  originScope,
  surface,
  takeover = false,
}: AsidePaneProps) {
  const [openDraftScope, setOpenDraftScope] = useState<string | null>(null)
  // "Insert into draft" on one of Ariadne's replies: the block goes into an
  // aside draft — the open one, else a new one — never into the chat composer
  // (that would address it back to Ariadne). Queued here because the editor
  // mounts with the draft; it appends the blocks once the draft has loaded.
  const [pendingAgentBlocks, setPendingAgentBlocks] = useState<AgentBlockData[]>([])
  const insertAgentBlock = useCallback(
    (data: AgentBlockData) => {
      setPendingAgentBlocks((pending) => [...pending, data])
      setOpenDraftScope((scope) => scope ?? newAsideDraftScope(asideId))
    },
    [asideId]
  )
  const consumePendingAgentBlocks = useCallback(() => setPendingAgentBlocks([]), [])
  const handoff = useAsideHandoff(workspaceId)
  const sendToComposer = useCallback(
    async ({ content, attachments }: AsideDraftHandoff) => {
      const queued = await handoff({ hostStreamId, originScope, content, attachments })
      // Get out of the composer's way once the blocks are on their way to it.
      // The aside closes rather than parking: its anchor row is still in the
      // timeline, and that is the one way back in.
      if (queued) closeAside()
      return queued
    },
    [handoff, hostStreamId, originScope]
  )

  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  const callDocked = useCallDocked()

  return (
    <div
      data-testid="aside-pane"
      data-aside-id={asideId}
      data-surface={surface}
      data-editor-zone="aside"
      className="flex h-full min-h-0 flex-col border-t-2 border-primary/70 bg-card"
    >
      <TooltipProvider delayDuration={300}>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b pl-3 pr-1.5">
          <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{title}</h2>
          {/* Nobody else can open this stream — the badge says so where the
              surface is read, not only where it was created. */}
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border/80 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            <Eye className="h-2.5 w-2.5 text-primary" aria-hidden />
            Only you
          </span>
          <span className="flex-1" />
          {!takeover && <AsideSurfacePicker value={surface} onChange={setAsideSurface} dockDisabled={callDocked} />}
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
      <AsideAnchorLine workspaceId={workspaceId} hostStreamId={hostStreamId} anchorId={aside?.parentAnchorId} />
      {openDraftScope ? (
        <AsideDraftEditor
          workspaceId={workspaceId}
          scope={openDraftScope}
          onBack={() => setOpenDraftScope(null)}
          onSendToComposer={sendToComposer}
          pendingAgentBlocks={pendingAgentBlocks}
          onPendingAgentBlocksConsumed={consumePendingAgentBlocks}
        />
      ) : (
        <>
          <AsideDraftDock
            workspaceId={workspaceId}
            asideId={asideId}
            onOpenDraft={setOpenDraftScope}
            openScope={openDraftScope}
          />
          <div className="relative min-h-0 flex-1">
            <StreamErrorBoundary streamId={asideId}>
              <AgentBlockProvider onInsert={insertAgentBlock}>
                <StreamContent
                  workspaceId={workspaceId}
                  streamId={asideId}
                  stream={aside}
                  autoFocus={!takeover}
                  emptyState={
                    <div className="max-w-[15rem] px-6 text-center">
                      <p className="text-[13px] text-foreground/80">A private page beside this conversation.</p>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                        Think out loud with Ariadne, or start a draft — nothing here is sent until you send it.
                      </p>
                    </div>
                  }
                />
              </AgentBlockProvider>
            </StreamErrorBoundary>
          </div>
        </>
      )}
    </div>
  )
}
