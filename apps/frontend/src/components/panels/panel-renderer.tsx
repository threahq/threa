import { lazy, Suspense } from "react"
import { PanelLeftClose } from "lucide-react"
import { isViewPanel } from "@/contexts/panel-context"
import { Skeleton } from "@/components/ui/skeleton"
import { SidePanel, SidePanelHeader, SidePanelClose, SidePanelContent } from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import { parseViewPanel } from "./panel-locations"

// Lazy chunks: stream/thread panels ride with the timeline+composer bundle the
// stream page already loads; view panels ride with their page chunks.
const StreamPanel = lazy(() => import("@/components/thread/stream-panel").then((m) => ({ default: m.StreamPanel })))
const SavedViewPanel = lazy(() => import("./view-panels").then((m) => ({ default: m.SavedViewPanel })))
const ActivityViewPanel = lazy(() => import("./view-panels").then((m) => ({ default: m.ActivityViewPanel })))

function PanelLoading() {
  return (
    <div className="flex h-full flex-col border-l bg-background">
      <div className="flex h-12 items-center border-b px-4">
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="flex-1 space-y-3 p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}

function UnknownPanel({ panelId, onClose }: { panelId: string; onClose: () => void }) {
  return (
    <SidePanel>
      <SidePanelHeader>
        <span className="flex-1 truncate text-sm font-semibold">Unknown panel</span>
        <SidePanelClose onClose={onClose} />
      </SidePanelHeader>
      <SidePanelContent className="flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <PanelLeftClose className="h-6 w-6" />
        <p className="max-w-[28ch] px-4 text-center text-sm">
          This link points at a panel this version of the app doesn't recognize ({panelId}).
        </p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close panel
        </Button>
      </SidePanelContent>
    </SidePanel>
  )
}

interface PanelContentRendererProps {
  panelId: string
  workspaceId: string
  onClose: () => void
}

/**
 * Resolves a panel id to its content surface: "view:<name>" ids render the
 * named view inside the shared panel chrome; anything else is treated as a
 * stream id (channels, threads, scratchpads, "draft:…" draft threads) and
 * rendered by StreamPanel.
 */
export function PanelContentRenderer({ panelId, workspaceId, onClose }: PanelContentRendererProps) {
  const view = parseViewPanel(panelId)

  let content: React.ReactNode
  if (view?.view === "saved") {
    content = <SavedViewPanel panelId={panelId} workspaceId={workspaceId} subView={view.subView} onClose={onClose} />
  } else if (view?.view === "activity") {
    content = <ActivityViewPanel panelId={panelId} workspaceId={workspaceId} subView={view.subView} onClose={onClose} />
  } else if (isViewPanel(panelId)) {
    content = <UnknownPanel panelId={panelId} onClose={onClose} />
  } else {
    content = <StreamPanel workspaceId={workspaceId} panelId={panelId} onClose={onClose} />
  }

  return <Suspense fallback={<PanelLoading />}>{content}</Suspense>
}
