import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import { Lock, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StreamContent } from "@/components/timeline"
import { StreamErrorBoundary } from "@/components/stream-error-boundary"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useStreamName } from "@/hooks/use-stream-name"
import { closeAside, setAsideSurface } from "@/stores/aside-store"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { StreamTypes } from "@threa/types"
import { cn } from "@/lib/utils"
import { useCallDocked } from "./use-call-docked"
import { AsideSurfacePicker } from "./aside-surface-picker"
import { AsideAnchorLine } from "./aside-anchor-line"
import { AsideConversation } from "./aside-conversation"
import { AsideDrafts } from "./aside-drafts"
import { ASIDE_META, ASIDE_PANE, ASIDE_PANE_HEAD, AsideGlyph, AsidePrivateBadge } from "./aside-chrome"
import { useAsideDraftSurface } from "./use-aside-draft-surface"
import { useAsideDrafts } from "./use-aside-drafts"

interface AsideFullscreenStageProps {
  workspaceId: string
  asideId: string
  hostStreamId: string
  originScope: string
}

/**
 * Fullscreen: the aside takes the content region, and the host stream comes
 * with it as reference. Left is the real timeline — live, scrollable, and
 * mute: while you are in here the only way a message reaches that stream is
 * through the draft on the right, so its composer is not merely disabled, it
 * is absent, and the pane says so. The page mounts no timeline of its own
 * while this stands, so there is exactly one host timeline on screen.
 */
export function AsideFullscreenStage({ workspaceId, asideId, hostStreamId, originScope }: AsideFullscreenStageProps) {
  const draftSurface = useAsideDraftSurface({ workspaceId, asideId, hostStreamId, originScope })
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const host = useMemo(() => streams.find((stream) => stream.id === hostStreamId), [streams, hostStreamId])
  const hostName = useStreamName(workspaceId, hostStreamId, "breadcrumb")
  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  const drafts = useAsideDrafts(workspaceId, asideId)
  const callDocked = useCallDocked()
  // The anchor line jumps by `?m=`, and while the stage stands this pane is
  // the only host timeline mounted — so it is the one that has to hear it.
  const [searchParams] = useSearchParams()

  return (
    <div
      data-testid="aside-fullscreen-stage"
      data-editor-zone="aside"
      className="absolute inset-0 z-30 flex flex-col bg-muted/40"
    >
      <TooltipProvider delayDuration={300}>
        <header className="flex h-12 shrink-0 items-center gap-2.5 border-b bg-background px-4">
          <AsideGlyph className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <h2 className="shrink-0 truncate text-[13px] font-semibold tracking-tight">{title}</h2>
          <AsidePrivateBadge />
          <AsideAnchorLine
            workspaceId={workspaceId}
            hostStreamId={hostStreamId}
            anchorId={aside?.parentAnchorId}
            variant="chip"
          />
          <span className="flex-1" />
          {drafts.length > 0 && (
            <span className={ASIDE_META}>
              {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
            </span>
          )}
          <AsideSurfacePicker value="fullscreen" onChange={setAsideSurface} dockDisabled={callDocked} />
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

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div className={cn(ASIDE_PANE, "flex-[0.95] basis-0")}>
          <div className={ASIDE_PANE_HEAD}>
            <span className="min-w-0 truncate font-medium text-foreground">{hostName ?? "Conversation"}</span>
            <span className="flex-1" />
            <span className={ASIDE_META}>read only</span>
          </div>
          <div className="relative min-h-0 flex-1">
            <StreamErrorBoundary streamId={hostStreamId}>
              <StreamContent
                workspaceId={workspaceId}
                streamId={hostStreamId}
                stream={host}
                highlightMessageId={searchParams.get("m")}
                hideComposer
              />
            </StreamErrorBoundary>
          </div>
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-border/70 px-3">
            <Lock className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden />
            <span className={ASIDE_META}>Reading. Replies leave from your draft.</span>
          </div>
        </div>

        <div className="flex min-h-0 flex-[1.02] basis-0 flex-col gap-3">
          <AsideDrafts
            workspaceId={workspaceId}
            asideId={asideId}
            surface={draftSurface}
            className={cn(ASIDE_PANE, draftSurface.openScope ? "min-h-0 flex-1 basis-0" : "shrink-0")}
          />
          <div className={cn(ASIDE_PANE, "min-h-0 flex-[1.45] basis-0")}>
            <div className={ASIDE_PANE_HEAD}>
              <AsideGlyph className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span className="font-medium text-foreground">Conversation</span>
            </div>
            <div className="relative min-h-0 flex-1">
              <AsideConversation
                workspaceId={workspaceId}
                asideId={asideId}
                aside={aside}
                autoFocus={!draftSurface.openScope}
                onInsertAgentBlock={draftSurface.insertAgentBlock}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
