import { useEffect } from "react"
import { useParams } from "react-router-dom"
import { panelIdsOf } from "@/lib/panel-tabs"
import { useStreamOrDraft, useStreamError, useTypeToFocus } from "@/hooks"
import { usePanel } from "@/contexts"
import { PagePanes } from "@/components/panes/page-panes"
import { StreamErrorView } from "@/components/stream-error-view"
import { getStreamName } from "@/lib/streams"
import { setPageStreamName } from "@/lib/page-title"

export function StreamPage() {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId: string }>()
  const { stream, error } = useStreamOrDraft(workspaceId!, streamId!)
  const { layout } = usePanel()

  useTypeToFocus()

  // Unified error checking - checks both coordinated loading and direct query errors. Beside other panes,
  // the stream's own pane shows its error and the rest stay usable.
  const streamError = useStreamError(streamId, error)
  const pageError = panelIdsOf(layout).length === 1 ? streamError : null

  // `stream.displayName` is already viewer-resolved by useStreamOrDraft (DM peer
  // names included), so the page title just reads the shared name off it.
  useEffect(() => {
    if (!stream) {
      setPageStreamName(null)
      return () => setPageStreamName(null)
    }
    setPageStreamName(getStreamName(stream))
    return () => setPageStreamName(null)
  }, [stream])

  if (!workspaceId || !streamId) {
    return null
  }

  return (
    <PagePanes
      workspaceId={workspaceId}
      error={pageError && <StreamErrorView type={pageError.type} workspaceId={workspaceId} />}
    />
  )
}
