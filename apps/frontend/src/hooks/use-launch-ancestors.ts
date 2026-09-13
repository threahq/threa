import { useEffect, useRef } from "react"
import { useLocation, useMatch, useNavigate } from "react-router-dom"
import { isDraftId } from "@/hooks/use-coordinated-stream-queries"
import { launchAncestors } from "@/lib/launch-ancestors"
import { isJournaledPath } from "@/lib/navigation-journal"
import { useWorkspaceStreams, useWorkspaceStreamsLoaded } from "@/stores/workspace-store"

// Once per JS context: a cold launch (PWA relaunch, direct URL, reload) is the
// only time the page has no history beneath it.
let launchHandled = false

export function resetLaunchAncestorsForTests(): void {
  launchHandled = false
}

/**
 * Gives the page a fresh JS context launched on the history it would have had
 * if reached in-app, so back walks the ancestors (thread → its channel, panel
 * → the page beneath) before it leaves the app. Fires on the first workspace
 * page this context renders, once the page's own stream row is cached (its
 * ancestors come from that row); a launch the viewer has already navigated
 * away from is left alone. The replace and pushes land in one React commit,
 * so the pushed hops carry a `launchRebuild` state, and the panel hop the
 * `panelPopsToClose` attestation PanelProvider reads.
 */
export function useRebuildLaunchAncestors(workspaceId: string | undefined): void {
  const location = useLocation()
  const navigate = useNavigate()
  const streamMatch = useMatch("/w/:workspaceId/s/:streamId")
  const pageStreamId = streamMatch?.params.streamId
  const streams = useWorkspaceStreams(workspaceId)
  const streamsLoaded = useWorkspaceStreamsLoaded(workspaceId)
  const launchKey = useRef<string | null>(null)

  const pageRowCached =
    pageStreamId === undefined || isDraftId(pageStreamId) || streams.some((s) => s.id === pageStreamId)

  useEffect(() => {
    if (launchHandled || !workspaceId) return
    if (!isJournaledPath(location.pathname, workspaceId)) return
    if (launchKey.current === null) launchKey.current = location.key
    if (location.key !== launchKey.current) {
      launchHandled = true
      return
    }
    if (!streamsLoaded || !pageRowCached) return
    launchHandled = true
    const hops = launchAncestors(location, workspaceId, streams)
    if (hops.length < 2) return
    navigate(hops[0].to, { replace: true })
    for (const hop of hops.slice(1)) navigate(hop.to, { state: hop.state })
  }, [workspaceId, location, navigate, streamsLoaded, pageRowCached, streams])
}
