import { useCallback, useMemo, useState } from "react"
import { Maximize2, Minus, PanelRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StreamContent } from "@/components/timeline"
import { AgentBlockProvider, type AgentBlockData } from "@/components/timeline/agent-block-context"
import { StreamErrorBoundary } from "@/components/stream-error-boundary"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { closeAside, setAsideSurface, type AsideSurface } from "@/stores/aside-store"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { StreamTypes } from "@threa/types"
import { cn } from "@/lib/utils"
import { useCallDocked } from "./use-call-docked"
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
      // Get out of the composer's way once the blocks are on their way to it;
      // the aside stays one tap away in the strip.
      if (queued) setAsideSurface("minimized")
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
      className="flex h-full min-h-0 flex-col border-t-2 border-primary/70 bg-background"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b pl-4 pr-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        {!takeover && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", surface === "dock" && "bg-accent text-accent-foreground")}
              aria-label="Dock aside"
              aria-pressed={surface === "dock"}
              disabled={callDocked}
              onClick={() => setAsideSurface("dock")}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", surface === "fullscreen" && "bg-accent text-accent-foreground")}
              aria-label="Aside fullscreen"
              aria-pressed={surface === "fullscreen"}
              onClick={() => setAsideSurface("fullscreen")}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Minimize aside"
              onClick={() => setAsideSurface("minimized")}
            >
              <Minus className="h-4 w-4" />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close aside" onClick={closeAside}>
          <X className="h-4 w-4" />
        </Button>
      </header>
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
                <StreamContent workspaceId={workspaceId} streamId={asideId} stream={aside} autoFocus={!takeover} />
              </AgentBlockProvider>
            </StreamErrorBoundary>
          </div>
        </>
      )}
    </div>
  )
}
