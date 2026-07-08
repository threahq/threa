import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { matchesBoardLens, type BoardLens, type BoardScopeStreamType } from "@threa/types"
import { useBoardPosts } from "@/stores/board-store"
import { projectNestedBoardView } from "@/lib/board/nested-board-view"
import {
  buildConversationGraph,
  useStreamStructuralIndex,
  branchParentConversationId,
} from "@/hooks/use-conversation-graph"
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

/**
 * The board's root-stream scope. `ids` are the selected root streams; a post
 * matches by its anchor's effective root (`rootStreamId`, computed server-side
 * with the same `COALESCE(root_stream_id, id)` rule the SQL scope filter uses),
 * so a thread-anchored conversation stays in its channel's scope. `key` is the
 * canonical serialization (sorted ids) — the view-reset key, so a re-created
 * `ids` Set with the same selection doesn't reset the frozen view.
 */
export interface BoardScope {
  key: string
  ids: ReadonlySet<string>
}

/**
 * Root-stream TYPE narrowing. Matches on the post's `rootStreamType` (the
 * effective root's type, server-computed — a thread-anchored conversation
 * counts as its channel/DM, never `thread`). Same key/ids split as
 * {@link BoardScope}.
 */
export interface BoardTypeScope {
  key: string
  ids: ReadonlySet<BoardScopeStreamType>
}

/**
 * A label filter, resolved to the streams it currently covers. `key` is the
 * canonical serialization of the SELECTED LABEL IDS — the view-reset key — while
 * `streamIds` is the live resolution of those labels to the viewer's labeled
 * streams (assignments change without changing the selection, so a re-resolution
 * must not reset the frozen view). Matching is anchor-or-root, the same rule as
 * the server's `boardLabelMatchSql`.
 */
export interface BoardLabelScope {
  key: string
  streamIds: ReadonlySet<string>
}

export interface BoardViewFilter {
  lens: BoardLens
  /** Root-stream scope, or null when unscoped (the whole workspace). */
  scope: BoardScope | null
  /** Root-stream TYPE scope, or null when every type shows. */
  types: BoardTypeScope | null
  /** Stream veto (anchor-or-root), or null when nothing is excluded. */
  excludeStreams: BoardScope | null
  /** Root-stream TYPE veto, or null. */
  excludeTypes: BoardTypeScope | null
  /** Label scope, or null when labels don't narrow the view. */
  labels: BoardLabelScope | null
  /** Label veto, or null. */
  excludeLabels: BoardLabelScope | null
  /**
   * Viewer opted into archived cards (`?archived=true`). A view SELECTION like
   * lens/scope — it rides the view-reset key, so toggling it re-commits the feed
   * (archived cards interleave by activity, and toggling back off re-hides them)
   * instead of silently appending them below the fold. Gates against each post's
   * own `rootArchived` verdict (the server's per-card archived flag), so it needs
   * no workspace-streams lookup — the bootstrap seeds active streams only.
   */
  showArchived: boolean
}

/**
 * The viewer's per-board exclusions (board-view-design.md § "Hide & mute"),
 * mirrored client-side so a hide/mute drops the card the instant it's written —
 * the read-side twin of the server's `boardHiddenExcludeSql`/`boardMutedExcludeSql`
 * (keep the boundaries identical to avoid SQL/JS drift). Both maps carry stable
 * identity from the exclusions store, so they're safe in memo deps.
 */
export interface BoardExclusionState {
  /** conversationId → `hiddenAt` (ms). A card revives when its activity passes it. */
  hidden: Map<string, number>
  /** Muted root-stream ids. */
  muted: Set<string>
  /** False when an explicit `?in=` scope is set — mute doesn't fight a stream the viewer named. */
  muteActive: boolean
}

const NO_EXCLUSIONS: BoardExclusionState = { hidden: new Map(), muted: new Set(), muteActive: true }

function matchesScope(post: CachedBoardPost, scope: BoardScope | null): boolean {
  if (!scope) return true
  // Cached rows predating `rootStreamId` fall back to the anchor itself — a
  // top-level anchor is its own root, so only pre-field thread anchors can
  // misclassify, and the next fetch reseeds them with the field.
  return scope.ids.has(post.rootStreamId ?? post.conversation.streamId)
}

function matchesTypeScope(post: CachedBoardPost, types: BoardTypeScope | null): boolean {
  if (!types) return true
  // Cached rows predating `rootStreamType` fail OPEN — the board surfaces
  // rather than hides — and the next fetch reseeds the field.
  if (post.rootStreamType === undefined) return true
  return types.ids.has(post.rootStreamType)
}

/**
 * Stream veto: anchor-or-root, the read-side twin of the server's
 * `boardScopeExcludeCondSql` (keep the rule identical). Root matching drops a
 * channel with everything under it; anchor matching lets one thread be excluded
 * without dropping its channel.
 */
function matchesExcludedStreams(post: CachedBoardPost, excluded: BoardScope | null): boolean {
  if (!excluded) return true
  return (
    !excluded.ids.has(post.rootStreamId ?? post.conversation.streamId) && !excluded.ids.has(post.conversation.streamId)
  )
}

/** TYPE veto. An unknown `rootStreamType` (pre-field cached row) fails OPEN,
 *  mirroring {@link matchesTypeScope} — the next fetch reseeds the field. */
function matchesExcludedTypes(post: CachedBoardPost, excluded: BoardTypeScope | null): boolean {
  if (!excluded) return true
  if (post.rootStreamType === undefined) return true
  return !excluded.ids.has(post.rootStreamType)
}

/** Does the post sit on a stream (anchor or effective root) the label scope covers? */
function onLabeledStream(post: CachedBoardPost, scope: BoardLabelScope): boolean {
  return (
    scope.streamIds.has(post.conversation.streamId) ||
    scope.streamIds.has(post.rootStreamId ?? post.conversation.streamId)
  )
}

function matchesLabelScope(post: CachedBoardPost, labels: BoardLabelScope | null): boolean {
  if (!labels) return true
  return onLabeledStream(post, labels)
}

function matchesExcludedLabels(post: CachedBoardPost, labels: BoardLabelScope | null): boolean {
  if (!labels) return true
  return !onLabeledStream(post, labels)
}

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
  /**
   * Whether the raw IDB feed (pre-lens/scope/exclusion filter) has ANY rows —
   * i.e. the store is seeded, even if the active filters hide everything.
   * Distinguishes a genuinely-empty filtered view (all cards hidden/muted/off-lens)
   * from a not-yet-seeded one, so the board can show its empty state instead of a
   * perpetual skeleton when the viewer filters down to zero.
   */
  hasRawPosts: boolean
}

/**
 * The board's stable-view projection: holds the order the viewer is looking at
 * frozen while live changes accumulate behind a pill, instead of re-sorting cards
 * under the eye. Wraps the live IDB feed (`useBoardPosts`); the committed snapshot
 * is React state, re-derived from the live feed without ever reordering a
 * committed card.
 *
 * The `filter` narrows the shared IDB feed to the cards that belong on the
 * active view: the structural lens (board-view-design.md § "Lenses" —
 * `matchesBoardLens`, the read-side authority matching the backend's
 * seed/pagination filter) and the root-stream scope. One IDB table holds every
 * seeded conversation regardless of filter, so filtering here is what makes each
 * view show its own subset live; changing lens or scope resets the frozen view so
 * the pill and order start fresh for the new subset.
 *
 * A card the viewer just acted on never vanishes under them: acting can change a
 * card's lens membership (a reply makes a Needs-resolution card fresh), which
 * drops it from the filtered live feed — but a committed card that leaves the
 * feed keeps rendering in place from `retainedRef` until the next commit, and its
 * body stays live off the message rails. Filters narrow what surfaces; they never
 * yank what's on screen.
 */
export function useStableBoardView(
  workspaceId: string,
  filter: BoardViewFilter,
  exclusions: BoardExclusionState = NO_EXCLUSIONS
): StableBoardView {
  const { lens, scope, types, excludeStreams, excludeTypes, labels, excludeLabels, showArchived } = filter
  const { hidden, muted, muteActive } = exclusions
  const rawLive = useBoardPosts(workspaceId)

  // A hidden card is excluded until it revives (activity passes its `hiddenAt`
  // watermark — mirrors the server `<=` boundary); a muted stream's cards are
  // excluded unless the viewer named explicit streams via `?in=` (`muteActive`);
  // a card whose effective root is archived is excluded unless the viewer opted
  // into `showArchived` (`post.rootArchived` is the server's per-card verdict,
  // the read-side twin of `boardArchivedExcludeSql` — a card seeded under
  // `?archived=true` re-hides here the instant archived is toggled back off).
  const isExcluded = useCallback(
    (post: CachedBoardPost): boolean => {
      const hiddenAt = hidden.get(post.conversation.id)
      if (hiddenAt !== undefined && postMs(post) <= hiddenAt) return true
      if (muteActive && muted.has(post.rootStreamId ?? post.conversation.streamId)) return true
      if (!showArchived && post.rootArchived === true) return true
      return false
    },
    [hidden, muted, muteActive, showArchived]
  )

  // The branch relationship for one-card-per-root suppression (below) derives
  // from the SAME posts array being filtered, not the shared graph registry: the
  // registry is a second liveQuery over the same table, and racing it means the
  // first commit can paint a child card standalone only to fold it away a beat
  // later — a card vanishing on refresh. Building from `rawLive` makes
  // suppression consistent with its input by construction; cards keep the
  // registry hook (they mount without the board list) and both build the same
  // index shape.
  const graph = useMemo(() => (rawLive ? buildConversationGraph(rawLive) : null), [rawLive])
  const index = useStreamStructuralIndex(workspaceId)
  // Filter the shared feed to the lens + scopes + exclusions, then fold branch
  // conversations into their parent's card (one card per root discussion — a child
  // whose parent survives the same filters is suppressed and bumps the parent's
  // effective activity; a child whose parent is filtered out stays standalone). The
  // fold runs BEFORE reconcile, so the committed-view machinery only ever sees the
  // projected list. Recomputed when the feed or filter changes; `Date.now()` is
  // sampled then (the staleness signal for `needs-resolution` only needs to be
  // fresh at feed-change granularity, which is frequent on a live board).
  const live = useMemo(
    () =>
      rawLive === undefined || graph === null
        ? undefined
        : projectNestedBoardView(
            rawLive.filter(
              (post) =>
                matchesBoardLens(post, lens, Date.now()) &&
                matchesScope(post, scope) &&
                matchesTypeScope(post, types) &&
                matchesExcludedStreams(post, excludeStreams) &&
                matchesExcludedTypes(post, excludeTypes) &&
                matchesLabelScope(post, labels) &&
                matchesExcludedLabels(post, excludeLabels) &&
                !isExcluded(post)
            ),
            (conversationId) => branchParentConversationId(conversationId, index, graph)
          ),
    [rawLive, lens, scope, types, excludeStreams, excludeTypes, labels, excludeLabels, isExcluded, graph, index]
  )
  const [committed, setCommitted] = useState<CommittedView>(EMPTY_VIEW)
  const [buffered, setBuffered] = useState<string[]>([])
  // Last-known content for committed cards, so one that vanishes from the live
  // feed (deleted / lost access) keeps rendering in place until the next commit
  // drops it — a removal never shifts the rows below it.
  const retainedRef = useRef<Map<string, CachedBoardPost>>(new Map())
  const liveRef = useRef<CachedBoardPost[]>([])
  // Mirror of `buffered` for `revealNext` to read synchronously: the viewer's own
  // post can land in the buffer BEFORE `revealNext` arms (the optimistic IDB write
  // fires its liveQuery a tick before the send resolves), so arming also flushes
  // whatever is already buffered — otherwise the just-posted card would strand
  // behind its own pill.
  const bufferedRef = useRef<string[]>([])
  bufferedRef.current = buffered
  // One-shot: when armed, the next live change with fresh arrivals commits
  // instead of buffering — so the viewer's own just-posted card is revealed, not
  // hidden behind its own pill. Auto-disarms after REVEAL_ARM_MS so a post that
  // never lands a visible conversation can't leave it armed to fire on an
  // unrelated arrival minutes later. Deliberately survives the view reset below:
  // posting from a filtered view navigates back to the All home (the post might
  // not match the filter), and the arm must still be live there to surface the
  // authored card when it arrives after the fresh view's wholesale commit.
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

  // Reset the view when the workspace OR the filter (lens/scope/types) changes
  // in place (the board route keeps the same component instance across
  // `:workspaceId`, `:lens`, `?in=`, and `?is=`). React-blessed render-time reset; the
  // ref writes are idempotent and gated by the changed key. Switching filter
  // starts a fresh frozen order + empty pill so the new subset isn't reconciled
  // against the previous filter's committed cards.
  // The reset feeds THIS render's reconcile below, not just state. `setState`
  // during render doesn't update the `committed`/`buffered` bindings in place, so
  // reconciling the new lens's feed against the STALE (previous-lens) committed
  // would let the old lens's ids leak in: `reconcileStableView` keeps a non-empty
  // committed and classifies a fresh new-lens post below the stale floor as paged
  // (mixing ids) or above it as buffered (stranding it behind an empty "N new"
  // pill), never re-taking its wholesale-commit branch. Folding the reset into the
  // reconcile INPUT (`committedInput`/`bufferedInput`) makes the new lens start
  // from EMPTY_VIEW and commit its own feed wholesale.
  // Label keys are the SELECTED ids, not the resolved streams — a live
  // re-resolution (an assignment changing) must not reset the frozen view.
  const viewKey = `${workspaceId}|${lens}|${scope?.key ?? ""}|${types?.key ?? ""}|${excludeStreams?.key ?? ""}|${excludeTypes?.key ?? ""}|${labels?.key ?? ""}|${excludeLabels?.key ?? ""}|${showArchived ? "arch" : ""}`
  const viewKeyRef = useRef(viewKey)
  let committedInput = committed
  let bufferedInput = buffered
  if (viewKeyRef.current !== viewKey) {
    viewKeyRef.current = viewKey
    retainedRef.current = new Map()
    liveRef.current = []
    committedInput = EMPTY_VIEW
    bufferedInput = []
    if (committed !== EMPTY_VIEW) setCommitted(EMPTY_VIEW)
    if (buffered.length > 0) setBuffered([])
  }

  // Fold the live feed into the committed view during render (deriving state from
  // props/inputs, not an effect — the render reads `committed`/`buffered` below,
  // so an effect would paint one frame stale). `setState` during render bails out
  // and re-renders synchronously; the equality guards keep it from looping once
  // converged.
  if (live) {
    liveRef.current = live
    for (const post of live) retainedRef.current.set(postId(post), post)
    const next = reconcileStableView(committedInput, live)
    if (next.committed !== committedInput) setCommitted(next.committed)
    if (revealNextRef.current && next.buffered.length > 0) {
      disarmReveal()
      const snap = snapshot(live)
      if (!sameIds(snap.order, committedInput.order)) setCommitted(snap)
      if (bufferedInput.length > 0) setBuffered([])
    } else if (!sameIds(bufferedInput, next.buffered)) {
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
    // Flush anything already buffered (the post may have landed before this armed)…
    if (bufferedRef.current.length > 0) commit()
    // …and arm for an arrival still in flight (the send hasn't echoed yet).
    revealNextRef.current = true
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
    revealTimerRef.current = setTimeout(() => {
      revealNextRef.current = false
      revealTimerRef.current = null
    }, REVEAL_ARM_MS)
  }, [commit])

  const posts = useMemo(() => {
    const liveById = new Map((live ?? []).map((post) => [postId(post), post]))
    const out: CachedBoardPost[] = []
    for (const id of committed.order) {
      const post = liveById.get(id) ?? retainedRef.current.get(id)
      if (!post) continue
      // A committed card renders from `retainedRef` even after it leaves `live`,
      // so an involuntary drop (lost access, re-lensed by the viewer's own reply)
      // doesn't shift rows below it. But a VOLUNTARY hide/mute must drop NOW, not
      // wait for the next commit — so skip excluded ids here too, not just in the
      // `live` filter. (The retained copy is pruned on the next `commit()`.)
      if (isExcluded(post)) continue
      out.push(post)
    }
    return out
  }, [committed, live, isExcluded])

  return {
    posts,
    activityById: committed.activityById,
    newCount: buffered.length,
    commit,
    revealNext,
    isLoading: live === undefined,
    hasRawPosts: (rawLive?.length ?? 0) > 0,
  }
}
