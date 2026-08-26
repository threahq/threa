import { createContext, useCallback, useContext, useMemo, useRef } from "react"
import { toast } from "sonner"
import { useConversationService } from "@/contexts"
import { useWorkspaceStreamReadStates, useWorkspaceUnreadState } from "@/stores/workspace-store"
import { applyReadStateSnapshots } from "@/hooks/use-unread-counts"
import type { RowReadState } from "@/components/timeline/read-frontier-context"
import type { RenderableMessage } from "@/components/message/message-item"
import { isEffectivelyUnread } from "@/lib/board/ledger"

/**
 * Per-row read state + the two read actions for a conversation surface (board
 * card, conversation panel). Read truth stays message-granular and
 * stream-anchored — the row gates the
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

const EMPTY_OVERLAY: readonly string[] = []

export function useConversationRowRead(): ConversationRowRead | null {
  return useContext(ConversationReadContext)
}

export const ConversationReadProvider = ConversationReadContext.Provider

interface ReadFrontierRow {
  lastReadEventId: string | null
  lastReadSequence?: string | null
  lastReadAt: string | null
}

/**
 * Derive one row's effective read state against the conversation's spanned
 * streams. Every leg — member OR access-without-membership (INV-62) — resolves
 * through its OWN effective frontier: the membership mirror seeds the map and
 * the standalone read-state rows override it (row presence authoritative), so
 * a non-member thread leg carries its own watermark sequence once the lazy
 * per-stream bootstrap persisted its frontier. The overlay makes a row
 * effectively read regardless of sequence. A resolved null watermark (never
 * read / explicit unread-to-zero) sits before the first message, so every
 * sequenced row is unread. Sequenceless rows (projection/backfill) fall back
 * to the frontier's timestamp; `ungated` when nothing can decide (callers show
 * both actions / don't count unread).
 */
function deriveRowState(
  streamId: string,
  messageId: string,
  sequence: string | undefined,
  createdAt: string | Date,
  overlay: Record<string, string[]> | undefined,
  unreadCounts: Record<string, number> | undefined,
  frontierByStream: Map<string, ReadFrontierRow>
): RowReadState {
  if (overlay?.[streamId]?.includes(messageId)) return "read"

  // A stream whose effective unread is 0 is fully read — every row in it is at/
  // below the watermark or in the overlay by definition. This short-circuit is
  // what keeps the card honest when a watermark advance doesn't carry a
  // sequence the frontier map can see (mark-all-read advances counts to 0
  // without a per-stream sequence payload). Strict === 0: a missing entry means
  // "no data" (a leg with no frontier yet), which must fall through, not read.
  if (unreadCounts?.[streamId] === 0) return "read"

  const frontier = frontierByStream.get(streamId)
  if (frontier) {
    if (sequence != null && frontier.lastReadSequence != null) {
      return BigInt(sequence) > BigInt(frontier.lastReadSequence) ? "unread" : "read"
    }
    if (sequence != null && frontier.lastReadEventId == null) return "unread"
    if (frontier.lastReadAt != null) {
      return new Date(createdAt).getTime() > new Date(frontier.lastReadAt).getTime() ? "unread" : "read"
    }
    return "ungated"
  }

  // No frontier for this leg yet — it resolves through its own standalone row
  // once synced (a card only renders rows from streams whose per-stream
  // bootstrap ran, which persists the frontier). The old root `last_read_at`
  // time approximation is gone: an unresolved leg is ungated, not approximated.
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
): {
  value: ConversationRowRead
  hasUnread: (messages: RenderableMessage[]) => boolean
  /** The mark-read mutation without the failure toast — for viewport auto-read,
   * where a background action failing must stay silent (the next dwell retries);
   * the toast is reserved for the user-initiated menu action. */
  markReadSilently: (messageId: string) => Promise<void>
  /** Registers the auto-read pin `markUnread` invokes synchronously BEFORE its
   * request departs — a dwell-scheduled auto mark-read firing mid-flight would
   * otherwise race the explicit unread, with server arrival order deciding. */
  setExplicitUnreadListener: (listener: (() => void) | null) => void
  /** One stream's RAW read truth (watermark sequence + overlay ids) — what the
   * auto-read hook diffs to detect a cross-device mark-unread. Raw primitives,
   * not derived row state: derivation flaps (the `unreadCounts === 0`
   * short-circuit, the timestamp fallback) must never read as a regression, or
   * auto-read false-pins and wedges on a static board card. */
  getReadTruth: (streamId: string) => { lastReadSequence: string | null; readMessageIds: readonly string[] }
} {
  const conversationService = useConversationService()
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const overlay = unreadState?.readMessageIds
  const unreadCounts = unreadState?.unreadCounts
  const readStates = useWorkspaceStreamReadStates(workspaceId)

  // Read frontier per stream, sourced solely from stream_read_state. Row
  // presence is authoritative: a present null watermark is an explicit
  // unread-to-zero; an absent row is never-read.
  const frontierByStream = useMemo(() => {
    const map = new Map<string, ReadFrontierRow>()
    for (const rs of readStates) {
      map.set(rs.streamId, {
        lastReadEventId: rs.lastReadEventId,
        lastReadSequence: rs.lastReadSequence,
        lastReadAt: rs.lastReadAt,
      })
    }
    return map
  }, [readStates])

  const state = useCallback<ConversationRowRead["state"]>(
    (streamId, messageId, sequence, createdAt) =>
      deriveRowState(streamId, messageId, sequence, createdAt, overlay, unreadCounts, frontierByStream),
    [overlay, unreadCounts, frontierByStream]
  )

  const markReadSilently = useCallback(
    (messageId: string) => {
      // Mutation departure time: the response applies per-stream only to legs
      // NOT touched after this instant (its own socket echo or a later action
      // — e.g. an explicit unread this stale read must not erase). The echo is
      // canonical; a delayed response is a no-op on touched legs.
      const startedAt = Date.now()
      return conversationService
        .markRead(workspaceId, conversationId, messageId)
        .then((res) => applyReadStateSnapshots(workspaceId, res.streams, startedAt))
    },
    [conversationService, workspaceId, conversationId]
  )

  const markReadUpToHere = useCallback(
    (messageId: string) => {
      markReadSilently(messageId).catch(() => toast.error("Couldn't mark as read"))
    },
    [markReadSilently]
  )

  const getReadTruth = useCallback(
    (streamId: string) => ({
      lastReadSequence: frontierByStream.get(streamId)?.lastReadSequence ?? null,
      readMessageIds: overlay?.[streamId] ?? EMPTY_OVERLAY,
    }),
    [frontierByStream, overlay]
  )

  const explicitUnreadListenerRef = useRef<(() => void) | null>(null)
  const setExplicitUnreadListener = useCallback((listener: (() => void) | null) => {
    explicitUnreadListenerRef.current = listener
  }, [])

  const markUnread = useCallback(
    (messageId: string) => {
      explicitUnreadListenerRef.current?.()
      const startedAt = Date.now()
      conversationService
        .markUnread(workspaceId, conversationId, messageId)
        .then((res) => applyReadStateSnapshots(workspaceId, res.streams, startedAt))
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
      messages.some((m) => isEffectivelyUnread(m, { currentUserId, fallbackStreamId: rootStreamId, state })),
    [state, currentUserId, rootStreamId]
  )

  return { value, hasUnread, markReadSilently, setExplicitUnreadListener, getReadTruth }
}
