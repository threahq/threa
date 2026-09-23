import { useMemo } from "react"
import { ENCRYPTED_MESSAGE_PREVIEW_LABEL } from "@threahq/types"
import { useActors } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { truncateContent } from "@/components/layout/sidebar/utils"
import { getStreamName } from "@/lib/streams"
import { useAgentActivityForStream } from "@/stores/agent-activity-store"
import { useWorkspaceStreams, useWorkspaceUnreadState } from "@/stores/workspace-store"

export interface LiveThread {
  name: string | null
  replyCount: number | null
  /** "Author: text" for the thread's newest message, as the sidebar shows it. */
  latest: { line: string; createdAt: string } | null
  unreadCount: number
  agentActive: boolean
}

/**
 * A thread row's live state from the workspace store, the rows the sidebar reads and
 * the socket keeps current. Null when the thread isn't in the store (never joined or
 * opened); the caller falls back to the context feed's snapshot.
 */
export function useLiveThread(workspaceId: string, threadId: string | null): LiveThread | null {
  const streams = useWorkspaceStreams(workspaceId)
  const unreadCounts = useWorkspaceUnreadState(workspaceId)?.unreadCounts
  const agentSessions = useAgentActivityForStream(workspaceId, threadId ?? undefined)
  const { getActorName } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const stream = useMemo(() => (threadId ? streams.find((s) => s.id === threadId) : undefined), [streams, threadId])

  if (!threadId || !stream) return null
  const preview = stream.lastMessagePreview
  let latest: LiveThread["latest"] = null
  if (preview?.content) {
    const author = getActorName(preview.authorId, preview.authorType)
    const text = stream.e2eEnabled ? ENCRYPTED_MESSAGE_PREVIEW_LABEL : truncateContent(preview.content, 80, toEmoji)
    latest = { line: `${author}: ${text}`, createdAt: preview.createdAt }
  }
  return {
    name: getStreamName(stream),
    replyCount: stream.replyCount ?? null,
    latest,
    unreadCount: unreadCounts?.[threadId] ?? 0,
    agentActive: agentSessions.length > 0,
  }
}
