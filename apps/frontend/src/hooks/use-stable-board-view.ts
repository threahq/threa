import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { matchesBoardLens, type BoardLens } from "@threa/types"
import { useBoardPosts } from "@/stores/board-store"
import type { CachedBoardPost } from "@/db"

/** How long `revealNext` stays armed after the viewer posts. Bounds the auto-
 *  reveal to the window right after their own action, so a stale arm can't later
 *  fire on an unrelated incoming conversation. */
const REVEAL_ARM_MS = 8000

/** A board post in the stable view — re-exported so UI (which can't import `@/db`
 *  directly, INV-15) shares the exact shape the hook renders from. */
export type BoardViewPost = CachedBoardPost

/**
 * A frozen snapshot of the board's order. The `conversations` IDB store stays
 * live and activity-sorted (the sync engine keeps it true); this is the order
 * the viewer is currently looking at, deliberately held still so a card never
 * jumps out from under the eye. Cards still read their *content* reactively from
 * IDB — a reply body fills in place — but their *position* is this snapshot's,
 * not the live order's, until the viewer commits a fresh one. See
 * `docs/board-view-design.md` § "Stable view + pending updates".
 */
export interface CommittedView {
  /** Conversation ids in frozen display order (activity-desc at commit time). */
  order: string[]
  /**
   * `lastActivityAt` (ms) captured at commit, keyed by id. The stable grouping
   * key — recency sections read this, not the live activity, so a bumped card
   * keeps its section as well as its position until commit.
   */
  activityById: Map<string, number>
}

const EMPTY_VIEW: CommittedView = { order: [], activityById: new Map() }

function postId(post: CachedBoardPost): string {
  return post.conversation.id
}

function postMs(post: CachedBoardPost): number {
  const ms = Date.parse(post.conversation.lastActivityAt)
  return Number.isNaN(ms) ? 0 : ms
}

function snapshot(live: CachedBoardPost[]): CommittedView {
  return {
    order: live.map(postId),
    activityById: new Map(live.map((post) => [postId(post), postMs(post)])),
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Fold the live IDB feed into the committed view. Two kinds of "not yet
 * committed" rows are told apart by the committed window's frozen lower bound:
 *
 *  - **Below the floor** — older content paged in by "Load more". It lands below
 *    the viewport, so appending it to the frozen order shifts nothing on-screen;
 *    fold it in immediately (no pill).
 *  - **At or above the floor** — a fresh arrival (new conversation, or a card
 *    bumped up past where it was). Revealing it would reorder the view, so it
 *    waits in the buffer and is surfaced as the "N new" pill count instead.
 *
 * Returns the same `committed` reference when nothing pages in, so the caller can
 * skip a state write.
 */
export function reconcileStableView(
  committed: CommittedView,
  live: CachedBoardPost[]
): { committed: CommittedView; buffered: string[] } {
  // First snapshot (initial load, or after a workspace reset): commit wholesale.
  // An empty feed has nothing to commit — keep the (empty) committed reference so
  // the caller doesn't churn fresh empty snapshots and loop.
  if (committed.order.length === 0) {
    return live.length === 0 ? { committed, buffered: [] } : { committed: snapshot(live), buffered: [] }
  }

  const committedSet = new Set(committed.order)
  let floor = Infinity
  for (const ms of committed.activityById.values()) if (ms < floor) floor = ms

  const paged: CachedBoardPost[] = []
  const buffered: string[] = []
  for (const post of live) {
    if (committedSet.has(postId(post))) continue
    if (postMs(post) < floor) paged.push(post)
    else buffered.push(postId(post))
  }

  if (paged.length === 0) {
    return { committed, buffered }
  }

  // Append paged-in older rows below the frozen window, activity-desc.
  paged.sort((a, b) => postMs(b) - postMs(a))
  const activityById = new Map(committed.activityById)
  for (const post of paged) activityById.set(postId(post), postMs(post))
  return {
    committed: { order: [...committed.order, ...paged.map(postId)], activityById },
    buffered,
  }
}

export interface StableBoardView {
  /** Frozen-order posts to render — position is the committed snapshot's, content is live. */
  posts: CachedBoardPost[]
  /** Commit-time activity (ms) per id, for monotonic recency grouping. */
  activityById: Map<string, number>
  /** Count of buffered new conversations behind the "N new" pill. */
  newCount: number
  /** Reveal buffered changes: re-snapshot the live order as the committed view. */
  commit: () => void
  /** Arm a one-shot auto-commit on the next live change (the viewer's own post). */
  revealNext: () => void
  /** True until the underlying IDB read first resolves. */
  isLoading: boolean
}

/**
 * The board's stable-view projection: holds the order the viewer is looking at
 * frozen while live changes accumulate behind a pill, instead of re-sorting cards
 * under the eye. Wraps the live IDB feed (`useBoardPosts`); the committed snapshot
 * is React state, re-derived from the live feed without ever reordering a
 * committed card.
 *
 * The `lens` narrows the shared IDB feed to the cards that belong on the active
 * structural lens (board-view-design.md § "Lenses") — the read-side authority
 * matching the backend's seed/pagination filter (`matchesBoardLens`). One IDB
 * table holds every seeded conversation regardless of lens, so filtering here is
 * what makes each lens show its own subset live; switching lens resets the frozen
 * view so the pill and order start fresh for the new subset.
 */
export function useStableBoardView(workspaceId: string, lens: BoardLens): StableBoardView {
  const rawLive = useBoardPosts(workspaceId)
  // Filter the shared feed to the lens. Recomputed when the feed or lens changes;
  // `Date.now()` is sampled then (the staleness signal for `needs-resolution` only
  // needs to be fresh at feed-change granularity, which is frequent on a live board).
  const live = useMemo(
    () => (rawLive === undefined ? undefined : rawLive.filter((post) => matchesBoardLens(post, lens, Date.now()))),
    [rawLive, lens]
  )
  const [committed, setCommitted] = useState<CommittedView>(EMPTY_VIEW)
  const [buffered, setBuffered] = useState<string[]>([])
  // Last-known content for committed cards, so one that vanishes from the live
  // feed (deleted / lost access) keeps rendering in place until the next commit
  // drops it — a removal never shifts the rows below it.
  const retainedRef = useRef<Map<string, CachedBoardPost>>(new Map())
  const liveRef = useRef<CachedBoardPost[]>([])
  // One-shot: when armed, the next live change with fresh arrivals commits
  // instead of buffering — so the viewer's own just-posted card is revealed, not
  // hidden behind its own pill. Auto-disarms after REVEAL_ARM_MS so a post that
  // never lands a visible conversation can't leave it armed to fire on an
  // unrelated arrival minutes later.
  const revealNextRef = useRef(false)
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disarmReveal = useCallback(() => {
    revealNextRef.current = false
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current)
      revealTimerRef.current = null
    }
  }, [])
  useEffect(() => disarmReveal, [disarmReveal])

  // Reset the view when the workspace OR the lens changes in place (the board
  // route keeps the same component instance across `:workspaceId` and `:lens`).
  // React-blessed render-time reset; the ref writes are idempotent and gated by
  // the changed key. Switching lens starts a fresh frozen order + empty pill so
  // the new subset isn't reconciled against the previous lens's committed cards.
  const viewKey = `${workspaceId}|${lens}`
  const viewKeyRef = useRef(viewKey)
  if (viewKeyRef.current !== viewKey) {
    viewKeyRef.current = viewKey
    retainedRef.current = new Map()
    liveRef.current = []
    revealNextRef.current = false
    setCommitted(EMPTY_VIEW)
    setBuffered([])
  }

  // Fold the live feed into the committed view during render (deriving state from
  // props/inputs, not an effect — the render reads `committed`/`buffered` below,
  // so an effect would paint one frame stale). `setState` during render bails out
  // and re-renders synchronously; the equality guards keep it from looping once
  // converged.
  if (live) {
    liveRef.current = live
    for (const post of live) retainedRef.current.set(postId(post), post)
    const next = reconcileStableView(committed, live)
    if (next.committed !== committed) setCommitted(next.committed)
    if (revealNextRef.current && next.buffered.length > 0) {
      disarmReveal()
      const snap = snapshot(live)
      if (!sameIds(snap.order, committed.order)) setCommitted(snap)
      if (buffered.length > 0) setBuffered([])
    } else if (!sameIds(buffered, next.buffered)) {
      setBuffered(next.buffered)
    }
  }

  const commit = useCallback(() => {
    const snap = snapshot(liveRef.current)
    setCommitted(snap)
    setBuffered([])
    const keep = new Set(snap.order)
    for (const id of [...retainedRef.current.keys()]) if (!keep.has(id)) retainedRef.current.delete(id)
  }, [])

  const revealNext = useCallback(() => {
    revealNextRef.current = true
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
    revealTimerRef.current = setTimeout(() => {
      revealNextRef.current = false
      revealTimerRef.current = null
    }, REVEAL_ARM_MS)
  }, [])

  const posts = useMemo(() => {
    const liveById = new Map((live ?? []).map((post) => [postId(post), post]))
    const out: CachedBoardPost[] = []
    for (const id of committed.order) {
      const post = liveById.get(id) ?? retainedRef.current.get(id)
      if (post) out.push(post)
    }
    return out
  }, [committed, live])

  return {
    posts,
    activityById: committed.activityById,
    newCount: buffered.length,
    commit,
    revealNext,
    isLoading: live === undefined,
  }
}
