import { useMemo } from "react"
import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { BOARD_LENSES, matchesBoardLens, type BoardLens } from "@threa/types"
import { db, type CachedBoardPost } from "@/db"

/** Per-root-stream topic tally shown on a board-mode sidebar row. `topics` counts
 *  the visible conversations whose effective root is that stream. No `unread`: the
 *  design doc's "N unread" needs per-conversation read truth (per-message watermarks via
 *  the sparse-read overlay, as board cards compute it), which this single pass
 *  over `db.conversations` can't derive without breaking the one-subscription
 *  perf contract — so unread is deliberately left off the stats line.
 *
 *  Counts are per CONVERSATION, not per rendered card: the board folds a branch
 *  conversation into its parent's card (`projectNestedBoardView`) when both are
 *  visible, so a stream with sub-topics can tally more topics here than it has
 *  top-level cards. Ratified: a folded branch is still a topic (it renders,
 *  nested), and folding depends on the filtered visible set — fold-aware counts
 *  would need the full projection per stream, breaking the single pass. */
export interface BoardStreamStats {
  topics: number
}

/** The single aggregation the board sidebar reads: per-root-stream tallies plus
 *  per-lens workspace totals, both from one pass over the cached board feed. */
export interface BoardSidebarStats {
  byStream: Map<string, BoardStreamStats>
  lensTotals: Record<BoardLens, number>
}

/** Shared zero tally for a stream the aggregation resolved but never counted (no
 *  topics) — a constant so the per-row lookup allocates nothing. */
export const ZERO_BOARD_STREAM_STATS: BoardStreamStats = { topics: 0 }

/**
 * Fold the cached board feed into the sidebar's per-stream + per-lens counts in a
 * single pass. A conversation counts as one "topic" under its effective root
 * (`rootStreamId ?? conversation.streamId` — the same COALESCE the board's scope
 * filter uses), unless it's an emptied shell (no messages — mirrors the server's
 * `cardinality(message_ids) > 0` board filter and `mergeBoardConversation`'s
 * delete-on-empty) or its root is archived (hidden on the board by default). Lens
 * totals reuse `matchesBoardLens`, the same read-side lens authority the board
 * card filters with, so the two surfaces can't drift.
 */
export function aggregateBoardSidebarStats(posts: CachedBoardPost[]): BoardSidebarStats {
  const byStream = new Map<string, BoardStreamStats>()
  const lensTotals = Object.fromEntries(BOARD_LENSES.map((lens) => [lens, 0])) as Record<BoardLens, number>
  for (const post of posts) {
    if (post.conversation.messageIds.length === 0) continue
    if (post.rootArchived === true) continue
    const rootId = post.rootStreamId ?? post.conversation.streamId
    let entry = byStream.get(rootId)
    if (!entry) {
      entry = { topics: 0 }
      byStream.set(rootId, entry)
    }
    entry.topics += 1
    for (const lens of BOARD_LENSES) if (matchesBoardLens(post, lens)) lensTotals[lens] += 1
  }
  return { byStream, lensTotals }
}

/**
 * One reactive pass over the workspace's cached board conversations, aggregated
 * for the board-mode sidebar (topic counts on rows, totals on the Lenses rows).
 *
 * Gated on `enabled`: off `/board`, the query function reads no table, so
 * `useLiveQuery` subscribes to nothing and chats mode pays zero cost. Returns
 * `null` while disabled or before the first IDB read resolves; the row treats
 * `null` as "not loaded yet" and renders no stats line until the data lands.
 *
 * The perf contract (board-centered-sidebar-exploration.md § "Topic stats"): this
 * is the ONLY subscription — call it once at the sidebar level and thread the
 * result to the rows via the board-mode descriptor, never a `liveQuery` per row.
 */
export function useBoardSidebarStats(workspaceId: string, enabled: boolean): BoardSidebarStats | null {
  const posts = useLiveQuery(async () => {
    // Off board mode, return before any table read so `useLiveQuery` subscribes
    // to nothing — chats mode pays zero cost.
    if (!enabled) return undefined
    return db.conversations
      .where("[workspaceId+_lastActivityMs]")
      .between([workspaceId, Dexie.minKey], [workspaceId, Dexie.maxKey])
      .toArray()
  }, [enabled, workspaceId])
  return useMemo(() => (posts ? aggregateBoardSidebarStats(posts) : null), [posts])
}
