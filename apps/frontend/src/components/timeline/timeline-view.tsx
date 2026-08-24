import { useParams, useSearchParams } from "react-router-dom"
import { StreamContent } from "./stream-content"

interface TimelineViewProps {
  isDraft?: boolean
  autoFocus?: boolean
  /** Show the stream as reference only — no composer (the aside's fullscreen host pane). */
  hideComposer?: boolean
}

export function TimelineView({ isDraft = false, autoFocus, hideComposer }: TimelineViewProps) {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId: string }>()
  const [searchParams] = useSearchParams()
  const highlightMessageId = searchParams.get("m")

  if (!workspaceId || !streamId) {
    return null
  }

  return (
    <StreamContent
      workspaceId={workspaceId}
      streamId={streamId}
      highlightMessageId={highlightMessageId}
      isDraft={isDraft}
      autoFocus={autoFocus}
      hideComposer={hideComposer}
    />
  )
}
