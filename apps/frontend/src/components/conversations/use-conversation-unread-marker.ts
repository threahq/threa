import { useCallback, useMemo, useRef, useState } from "react"
import type { ConversationRowRead } from "@/components/message/conversation-read-context"
import type { RenderableMessage } from "@/components/message/message-item"
import { useWorkspaceStreamReadStates, useWorkspaceUnreadState } from "@/stores/workspace-store"

/**
 * Whether every stream the given rows span can already be decided as read or
 * unread — the gate {@link useConversationUnreadMarker}'s `readStateResolved`
 * wants. A row whose leg has no frontier yet derives as `ungated`, so latching
 * before that would anchor the marker below the true first unread, and the latch
 * is one-way. A leg counts as decidable once it has a `stream_read_state` row or
 * a zero unread count (mark-all-read advances counts without a frontier).
 */
export function useConversationReadStateDecidable(
  workspaceId: string,
  rows: RenderableMessage[],
  rootStreamId: string
): boolean {
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const streamReadStates = useWorkspaceStreamReadStates(workspaceId)
  return useMemo(() => {
    if (unreadState === undefined) return false
    const decidable = new Set(streamReadStates.map((row) => row.streamId))
    for (const [streamId, count] of Object.entries(unreadState.unreadCounts ?? {})) {
      if (count === 0) decidable.add(streamId)
    }
    for (const row of rows) {
      if (!decidable.has(row.streamId ?? rootStreamId)) return false
    }
    return true
  }, [unreadState, streamReadStates, rows, rootStreamId])
}

/** One conversation's latched marker decision: where the divider sits, and
 *  whether it has already settled from red to muted. */
export interface UnreadMarkerLatch {
  messageId: string | null
  dimmed: boolean
}

/** Latch storage outliving the component, keyed by conversation id. Surfaces
 *  whose rows unmount while still "open" (the board's virtualised cards) pass
 *  one; the panel omits it and keeps its own per-open ref. */
export interface UnreadMarkerLatchStorage {
  get(conversationId: string): UnreadMarkerLatch | undefined
  set(conversationId: string, latch: UnreadMarkerLatch): void
}

interface UseConversationUnreadMarkerOptions {
  /** Resets the latch — one marker decision per conversation, per open. */
  conversationId: string
  /** The conversation's message rows, in render order. */
  rows: RenderableMessage[]
  /** Stream a row falls back to when it carries none (the conversation's anchor). */
  rootStreamId: string
  /** Per-row read state from {@link ConversationRowRead} — `"ungated"` never anchors. */
  rowState: ConversationRowRead["state"]
  currentUserId: string | null
  /** False until the workspace read state has loaded; the marker waits for it. */
  readStateResolved: boolean
  /** Ids that actually get a rendered row — a marker inside a collapsed subtree
   *  would draw no divider and have no scroll target. `null` = no filtering. */
  renderedMessageIds?: ReadonlySet<string> | null
  /** External latch storage; omit to latch in a component-local ref. */
  latchStorage?: UnreadMarkerLatchStorage
}

interface UseConversationUnreadMarkerResult {
  markerMessageId: string | null
  /** Unread, non-own rows at or after the marker — live, so it decays as auto-read runs. */
  unreadCount: number
  /** The marker's rows have all been read: the divider settles from red to muted. */
  isDimmed: boolean
  dismiss: () => void
}

/**
 * The conversation panel's first-unread landmark: where the "New" divider sits
 * and what the "N new messages" banner counts. Sibling to
 * `hooks/use-unread-divider.ts` — that one is single-stream (`StreamEvent[]` +
 * one `lastReadSequence`), this one is cross-stream (conversation rows, each
 * resolved through its own stream's frontier by `rowState`).
 */
export function useConversationUnreadMarker({
  conversationId,
  rows,
  rootStreamId,
  rowState,
  currentUserId,
  readStateResolved,
  renderedMessageIds = null,
  latchStorage,
}: UseConversationUnreadMarkerOptions): UseConversationUnreadMarkerResult {
  const firstUnreadId = useMemo(() => {
    if (!readStateResolved) return null
    for (const row of rows) {
      if (row.authorId === currentUserId) continue
      if (renderedMessageIds && !renderedMessageIds.has(row.id)) continue
      if (rowState(row.streamId ?? rootStreamId, row.id, row.sequence, row.createdAt) !== "unread") continue
      return row.id
    }
    return null
  }, [rows, rowState, currentUserId, rootStreamId, readStateResolved, renderedMessageIds])

  // Latched in RENDER, not an effect. Auto-read starts clearing the live unread
  // the moment the panel paints, and an effect-based latch would read the
  // already-cleared value on the commit that matters — the divider would be
  // drawn at the tail, or not at all. The ref resets on conversation change and
  // then captures the first non-null first-unread; nothing after that moves it.
  // With external storage the latch outlives the component (a board card is
  // unmounted by virtualisation while its board visit is still one "open"), and
  // the conversation key is what scopes it; the local ref is the panel's path.
  const latchRef = useRef<{ conversationId: string; messageId: string | null; dimmed: boolean }>({
    conversationId,
    messageId: null,
    dimmed: false,
  })
  // Explicit dismissal (the banner's ✕). A latched marker has no clear-on-read,
  // so a separate flag overrides it. Per-open like the marker itself: it clears
  // on a conversation change, so returning to a conversation with fresh unread
  // gets its own marker rather than staying silently downgraded.
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (latchRef.current.conversationId !== conversationId) {
    latchRef.current = { conversationId, messageId: null, dimmed: false }
    if (dismissed !== null) setDismissed(null)
  }
  let latch: UnreadMarkerLatch = latchRef.current
  if (latchStorage) {
    const stored = latchStorage.get(conversationId)
    if (stored) latch = stored
    else {
      latch = { messageId: null, dimmed: false }
      latchStorage.set(conversationId, latch)
    }
  }
  // Away-arrival re-latch, storage path only (the panel's per-open ref keeps the
  // strict one-way rule). A settled entry points at rows the user has read; when
  // new unread arrives strictly below it the muted divider marks nothing and the
  // mass badge contradicts it, so that entry is discarded and re-decided. Only
  // when dimmed: a live red divider must never move while unread is pending.
  if (latchStorage && latch.dimmed && latch.messageId !== null && firstUnreadId !== null) {
    const latchedIndex = rows.findIndex((row) => row.id === latch.messageId)
    const firstUnreadIndex = rows.findIndex((row) => row.id === firstUnreadId)
    if (latchedIndex >= 0 && firstUnreadIndex > latchedIndex) {
      latch = { messageId: null, dimmed: false }
      latchStorage.set(conversationId, latch)
    }
  }
  if (firstUnreadId && latch.messageId === null) {
    latch.messageId = firstUnreadId
  }

  const dismiss = useCallback(() => setDismissed(conversationId), [conversationId])

  const latched = latch.messageId
  const markerMessageId = dismissed === conversationId ? null : latched

  const unreadCount = useMemo(() => {
    if (!markerMessageId) return 0
    const start = rows.findIndex((row) => row.id === markerMessageId)
    if (start < 0) return 0
    let count = 0
    for (let i = start; i < rows.length; i++) {
      const row = rows[i]
      if (row.authorId === currentUserId) continue
      if (rowState(row.streamId ?? rootStreamId, row.id, row.sequence, row.createdAt) === "unread") count += 1
    }
    return count
  }, [markerMessageId, rows, rowState, currentUserId, rootStreamId])

  // Settling is one-way, like the timeline's: once the marker's rows have all
  // been read the divider stays muted for this open. A later arrival must not
  // re-redden a divider that now points at rows the user has already read.
  if (markerMessageId != null && unreadCount === 0) latch.dimmed = true
  const isDimmed = markerMessageId != null && latch.dimmed

  return { markerMessageId, unreadCount, isDimmed, dismiss }
}
