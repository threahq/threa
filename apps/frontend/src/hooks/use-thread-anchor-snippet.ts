import { useLiveQuery } from "dexie-react-hooks"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN, StreamTypes } from "@threahq/types"
import { db, type CachedStream } from "@/db"
import { useStreamFromStore } from "@/stores/stream-store"
import { getStreamName } from "@/lib/streams"
import { stripMarkdownToInline } from "@/lib/markdown"

const pickUnnamedThreadAnchor = (row: CachedStream) => ({
  // An E2E thread's name may be sealed (null here, resolved by `useStreamName`) and its anchor holds no plaintext.
  unnamedThread: row.type === StreamTypes.THREAD && !row.e2eEnabled && getStreamName(row) === null,
  parentStreamId: row.parentStreamId,
  anchorId: row.parentAnchorId ?? row.parentMessageId ?? null,
})

/**
 * The text of the message an unnamed thread hangs off, so threads still waiting
 * on their auto-name can be told apart. Local-only (the anchor sits in the
 * parent's cached timeline); `null` for a named stream, an uncached or deleted
 * anchor, or content with no plaintext (E2E).
 */
export function useThreadAnchorSnippet(workspaceId: string, streamId: string): string | null {
  const thread = useStreamFromStore(workspaceId, streamId, pickUnnamedThreadAnchor)
  const lookup = thread?.unnamedThread ? thread : null
  return useLiveQuery(
    async () => {
      if (!lookup?.parentStreamId || !lookup.anchorId) return null
      const events = await db.events
        .where("[workspaceId+payload.messageId]")
        .equals([workspaceId, lookup.anchorId])
        .toArray()
      const anchor = events.find(
        (event) => event.streamId === lookup.parentStreamId && event.eventType === "message_created"
      )
      const payload = anchor?.payload as { contentMarkdown?: unknown; deletedAt?: unknown } | undefined
      const markdown = payload?.contentMarkdown
      if (payload?.deletedAt || typeof markdown !== "string" || markdown === E2E_PLACEHOLDER_CONTENT_MARKDOWN)
        return null
      return stripMarkdownToInline(markdown) || null
    },
    [workspaceId, lookup?.parentStreamId, lookup?.anchorId],
    null
  )
}
