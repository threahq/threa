import { createContext, useCallback, useContext, useMemo } from "react"
import { toast } from "sonner"
import { useConversationService } from "@/contexts"
import { useWorkspaceStreamMemberships, useWorkspaceUnreadState } from "@/stores/workspace-store"
import { applyReadStateSnapshots } from "@/hooks/use-unread-counts"
import type { RowReadState } from "@/components/timeline/read-frontier-context"
import type { RenderableMessage } from "@/components/message/message-item"

/**
 * Per-row read state + the two read actions for a conversation surface (board
 * card, conversation panel). Read truth stays message-granular and
 * stream-anchored (docs/sparse-read-overlay-design.md) — the row gates the
 * "Mark as read" / "Mark as unread" menu entries by where it sits, and the
 * actions call the conversation read API and fold the returned snapshots into
 * the local read state. `null` (no provider — e.g. the label page) hides both
 * actions, the same field-one-side-sets gate as `conversationId`.
 */
export interface ConversationRowRead {
  state: (streamId: string, messageId: string, sequence: string | undefined, createdAt: string | Date) => RowReadState
  markReadUpToHere: (messageId: string) => void
  markUnread: (messageId: string) => void
}

const ConversationReadContext = createContext<ConversationRowRead | null>(null)

export function useConversationRowRead(): ConversationRowRead | null {
  return useContext(ConversationReadContext)
}

export const ConversationReadProvider = ConversationReadContext.Provider

interface ReadFrontierRow {
  lastReadSequence?: string | null
  lastReadAt: string | null
}

/**
 * Derive one row's effective read state against the conversation's spanned
 * streams. A member stream compares the row's per-stream `sequence` to the
 * stream's watermark sequence; a non-member thread leg (no membership row) falls
 * back to the root watermark's `last_read_at` timestamp (the v1 approximation —
 * docs/sparse-read-overlay-design.md § "Card unread derivation"). The overlay
 * makes a row effectively read regardless of sequence. Sequenceless rows
 * (projection/backfill) fall back to the same timestamp comparison; `ungated`
 * when nothing can decide (callers show both actions / don't count unread).
 */
function deriveRowState(
  streamId: string,
  messageId: string,
  sequence: string | undefined,
  createdAt: string | Date,
  overlay: Record<string, string[]> | undefined,
  frontierByStream: Map<string, ReadFrontierRow>,
  rootStreamId: string
): RowReadState {
  if (overlay?.[streamId]?.includes(messageId)) return "read"

  const membership = frontierByStream.get(streamId)
  if (membership) {
    if (sequence != null && membership.lastReadSequence != null) {
      return BigInt(sequence) > BigInt(membership.lastReadSequence) ? "unread" : "read"
    }
    if (membership.lastReadAt != null) {
      return new Date(createdAt).getTime() > new Date(membership.lastReadAt).getTime() ? "unread" : "read"
    }
    return "ungated"
  }

  const root = frontierByStream.get(rootStreamId)
  if (root?.lastReadAt != null) {
    return new Date(createdAt).getTime() > new Date(root.lastReadAt).getTime() ? "unread" : "read"
  }
  return "ungated"
}

/**
 * Owns a conversation surface's read state: builds the {@link ConversationRowRead}
 * provider value (per-row gating + the two actions) and a `hasUnread` predicate
 * for the card's unread dot. Both hosts (board card, panel) call it; it reads the
 * overlay and per-stream watermarks live from the workspace caches so the derived
 * state (and the dot) clear the instant a read lands. Own-authored rows never
 * count toward `hasUnread` — sending a message doesn't make the conversation
 * unread to yourself.
 */
export function useConversationReadController(
  workspaceId: string,
  conversationId: string,
  rootStreamId: string,
  currentUserId: string | null
): { value: ConversationRowRead; hasUnread: (messages: RenderableMessage[]) => boolean } {
  const conversationService = useConversationService()
  const overlay = useWorkspaceUnreadState(workspaceId)?.readMessageIds
  const memberships = useWorkspaceStreamMemberships(workspaceId)

  const frontierByStream = useMemo(() => {
    const map = new Map<string, ReadFrontierRow>()
    for (const m of memberships) {
      map.set(m.streamId, { lastReadSequence: m.lastReadSequence, lastReadAt: m.lastReadAt })
    }
    return map
  }, [memberships])

  const state = useCallback<ConversationRowRead["state"]>(
    (streamId, messageId, sequence, createdAt) =>
      deriveRowState(streamId, messageId, sequence, createdAt, overlay, frontierByStream, rootStreamId),
    [overlay, frontierByStream, rootStreamId]
  )

  const markReadUpToHere = useCallback(
    (messageId: string) => {
      conversationService
        .markRead(workspaceId, conversationId, messageId)
        .then((res) => applyReadStateSnapshots(workspaceId, res.streams))
        .catch(() => toast.error("Couldn't mark as read"))
    },
    [conversationService, workspaceId, conversationId]
  )

  const markUnread = useCallback(
    (messageId: string) => {
      conversationService
        .markUnread(workspaceId, conversationId, messageId)
        .then((res) => applyReadStateSnapshots(workspaceId, res.streams))
        .catch(() => toast.error("Couldn't mark as unread"))
    },
    [conversationService, workspaceId, conversationId]
  )

  const value = useMemo<ConversationRowRead>(
    () => ({ state, markReadUpToHere, markUnread }),
    [state, markReadUpToHere, markUnread]
  )

  const hasUnread = useCallback(
    (messages: RenderableMessage[]): boolean =>
      messages.some(
        (m) =>
          m.authorId !== currentUserId && state(m.streamId ?? rootStreamId, m.id, m.sequence, m.createdAt) === "unread"
      ),
    [state, currentUserId, rootStreamId]
  )

  return { value, hasUnread }
}
