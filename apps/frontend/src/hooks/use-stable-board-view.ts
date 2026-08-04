import { useCallback, useMemo, useRef, useState } from "react"
import { matchesBoardLens, type BoardLens, type BoardScopeStreamType } from "@threa/types"
import { useBoardPosts } from "@/stores/board-store"
import { projectNestedBoardView } from "@/lib/board/nested-board-view"
import {
  buildConversationGraph,
  useStreamStructuralIndex,
  branchParentConversationId,
} from "@/hooks/use-conversation-graph"
import type { CachedBoardPost } from "@/db"

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

/**
 * The board's unread narrowing (`?unread=true`). `key` is the SELECTION (just
 * "true" while active) — the view-reset key, so it never changes shape — while
 * `streamIds` is the resolution to the streams this unread SESSION covers.
 *
 * That set is a floor, not a live membership: the page latches every stream
 * that is unread while the view is open and never drops one on its own (Kris,
 * 2026-08). Reading a card in the unread view is the point of being there, so
 * the card it stands for must not vanish out from under the reader; leaving the
 * view (or a workspace switch) starts a fresh floor. A card leaves early only
 * by explicit will, through `clearedConversationIds`.
 */
export interface BoardUnreadScope {
  key: string
  streamIds: ReadonlySet<string>
  /** Cards the viewer cleared from this unread session by hand. */
  clearedConversationIds?: ReadonlySet<string>
}

/**
 * The board's drafts narrowing (`?drafts=true`). `key` is the SELECTION (just
 * "true" while active) — the view-reset key — while the two sets are the live
 * resolution off the shared board-drafts snapshot: conversations with a reply or
 * branch-reply draft, and messages carrying a sub-topic draft (a conversation
 * matches when any of its messages does).
 *
 * Unlike {@link BoardUnreadScope} there is no session floor: the committed view
 * is re-checked, so losing membership sheds the card immediately — sending or
 * discarding a draft is the viewer's own act on that card. Clearing the text
 * mid-rewrite is editing, not resolving, so a checked-out row keeps membership
 * even with no payload and the card can't be yanked out from under a focused
 * composer.
 */
export interface BoardDraftScope {
  key: string
  conversationIds: ReadonlySet<string>
  subtopicMessageIds: ReadonlySet<string>
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
  /** Unread-only narrowing, or null when every conversation shows regardless of
   *  read state. */
  unread: BoardUnreadScope | null
  /** Drafts-only narrowing, or null when every conversation shows regardless of
   *  unsent drafts. */
  drafts: BoardDraftScope | null
  /**
   * Viewer opted into archived cards (`?archived=true`). A view SELECTION like
   * lens/scope — it rides the view-reset key, so toggling it re-commits the feed
   * (archived cards interleave by activity, and toggling back off re-hides them)
   * instead of silently appending them below the fold. Gates against each post's
   * own `rootArchived` verdict AND against `archivedRootIds`.
   */
  showArchived: boolean
  /**
   * Roots archived per the local stream index (the bootstrap ships archived rows
   * since #1420). The per-card `rootArchived` flag stays primary — it survives
   * per-row in IDB with no root-row resolution — but the server excludes archived
   * conversations from every fetch, so a card cached with `rootArchived: false`
   * before its root was archived is never reseeded and would render forever.
   * This set is the fresher veto over that stale flag.
   */
  archivedRootIds: ReadonlySet<string>
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

/**
 * The network seed's state, as the board page knows it. `settled` is "the query
 * is no longer loading (or the escape-hatch timeout fired)"; `newest` is the
 * newest conversation the settled query returned (id + its `lastActivityAt` in
 * ms), or null when there is nothing to wait for (timeout, error, empty). The
 * hook holds its first commit until the seed has SETTLED *and* that SNAPSHOT —
 * not merely the id — is visible in the IDB feed: when the newest activity is a
 * reply to an old conversation the id is already cached at its stale activity,
 * so an id-presence check opens the gate before the bulkPut lands and commits
 * the stale order. Matching the activity proves the seeded rows arrived (they
 * land one or more renders later through an un-awaited bulkPut + liveQuery
 * re-emission).
 */
export interface BoardSeedState {
  settled: boolean
  newest: { id: string; activityMs: number } | null
}

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

function matchesUnread(post: CachedBoardPost, unread: BoardUnreadScope | null): boolean {
  if (!unread) return true
  if (unread.clearedConversationIds?.has(post.conversation.id)) return false
  return unread.streamIds.has(post.rootStreamId ?? post.conversation.streamId)
}

function matchesDrafts(post: CachedBoardPost, drafts: BoardDraftScope | null): boolean {
  if (!drafts) return true
  if (drafts.conversationIds.has(post.conversation.id)) return true
  return post.conversation.messageIds?.some((id) => drafts.subtopicMessageIds.has(id)) ?? false
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
 * Fold the live IDB feed into the committed view. A "not yet committed" row is
 * classified against the committed window's frozen lower bound:
 *
 *  - **Below the floor** — older content paged in by "Load more". It lands below
 *    the viewport, so appending it to the frozen order shifts nothing on-screen;
 *    fold it in immediately (no pill).
 *  - **The viewer's own optimistic post** (`_status === "pending"`, only ever set
 *    by `putOptimisticBoardPost`/`reconcileOptimisticBoardPost` for the author's
 *    own send) — revealed at top immediately, regardless of any timer. The authored
 *    card must surface as soon as it lands, whether that's inline (existing-stream)
 *    or at composer-clear (a new scratchpad, keyed by the client-minted id).
 *    Revealing ONLY the pending card leaves unrelated arrivals still buffered, so
 *    posting never reorders the cards the viewer was reading (board-view-design.md
 *    "don't move shit on me").
 *  - **Any other at-or-above-floor NEW conversation** — waits in the buffer so
 *    revealing it cannot reorder the view under the reader. Activity on a
 *    committed card updates that card in place and never contributes to the pill;
 *    the control must always reveal a genuinely new card when tapped.
 *
 * Returns the same `committed` reference when nothing pages in or reveals, so the
 * caller can skip a state write.
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
  const revealed: CachedBoardPost[] = []
  const buffered: string[] = []
  for (const post of live) {
    const id = postId(post)
    if (committedSet.has(id)) continue
    if (post._status === "pending") revealed.push(post)
    else if (postMs(post) < floor) paged.push(post)
    else buffered.push(id)
  }

  if (paged.length === 0 && revealed.length === 0) return { committed, buffered }

  // The viewer's own pending posts prepend at top (newest); paged-in older rows
  // append below the frozen window. Both activity-desc; the committed cards
  // between keep their frozen positions.
  revealed.sort((a, b) => postMs(b) - postMs(a))
  paged.sort((a, b) => postMs(b) - postMs(a))
  const activityById = new Map(committed.activityById)
  for (const post of [...revealed, ...paged]) activityById.set(postId(post), postMs(post))
  return {
    committed: {
      order: [...revealed.map(postId), ...committed.order, ...paged.map(postId)],
      activityById,
    },
    buffered,
  }
}

/** The conversation a merged-away card's opening message now belongs to. */
export interface RemovedSuccessor {
  conversationId: string
  topicSummary: string | null
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
  /**
   * Committed ids whose row is gone from the RAW feed — merged away or emptied,
   * so the conversation no longer exists rather than merely falling out of the
   * active filters. They keep their slot: the retained copy still renders, inert,
   * at its full height under an overlay, so nothing below it shifts.
   * Empty while the feed is still loading. Also carries cards shed by the drafts
   * view once their draft resolved (see {@link draftResolvedIds}) — same
   * treatment, different reason.
   */
  removedIds: ReadonlySet<string>
  /**
   * Per removed id, the conversation that now holds its opening message (a merge
   * target), or null when nothing does. Resolved once here off the same raw feed
   * the removal verdict comes from — never per card, which would put a full-feed
   * subscription behind every stub.
   */
  removedSuccessorById: ReadonlyMap<string, RemovedSuccessor | null>
  /**
   * The subset of {@link removedIds} shed because their draft resolved, not
   * because the conversation is gone — the card is still real, it just left the
   * `?drafts=true` view. Distinguished so the removed-card overlay says so
   * instead of claiming the conversation left the board.
   */
  draftResolvedIds: ReadonlySet<string>
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
  exclusions: BoardExclusionState = NO_EXCLUSIONS,
  seed: BoardSeedState | undefined
): StableBoardView {
  const {
    lens,
    scope,
    types,
    excludeStreams,
    excludeTypes,
    labels,
    excludeLabels,
    unread,
    drafts,
    showArchived,
    archivedRootIds,
  } = filter
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
      if (!showArchived) {
        if (post.rootArchived === true) return true
        if (archivedRootIds.has(post.rootStreamId ?? post.conversation.streamId)) return true
      }
      return false
    },
    [hidden, muted, muteActive, showArchived, archivedRootIds]
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
  // projected list. Recomputed when the feed or filter changes.
  const live = useMemo(
    () =>
      rawLive === undefined || graph === null
        ? undefined
        : projectNestedBoardView(
            rawLive.filter(
              (post) =>
                matchesBoardLens(post, lens) &&
                matchesScope(post, scope) &&
                matchesTypeScope(post, types) &&
                matchesExcludedStreams(post, excludeStreams) &&
                matchesExcludedTypes(post, excludeTypes) &&
                matchesLabelScope(post, labels) &&
                matchesExcludedLabels(post, excludeLabels) &&
                matchesUnread(post, unread) &&
                matchesDrafts(post, drafts) &&
                !isExcluded(post)
            ),
            (conversationId) => branchParentConversationId(conversationId, index, graph)
          ),
    [
      rawLive,
      lens,
      scope,
      types,
      excludeStreams,
      excludeTypes,
      labels,
      excludeLabels,
      unread,
      drafts,
      isExcluded,
      graph,
      index,
    ]
  )
  const [committed, setCommitted] = useState<CommittedView>(EMPTY_VIEW)
  const [buffered, setBuffered] = useState<string[]>([])
  // Last-known content for committed cards, so one that vanishes from the live
  // feed (deleted / lost access) keeps rendering in place until the next commit
  // drops it — a removal never shifts the rows below it.
  const retainedRef = useRef<Map<string, CachedBoardPost>>(new Map())
  const liveRef = useRef<CachedBoardPost[]>([])

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
  // `archivedRootIds` is deliberately NOT in this key: the veto drops at render
  // (`isExcluded` runs over committed cards too), so a root archived mid-view
  // loses its card immediately without resetting the reader's frozen view. On
  // unarchive, a card archived DURING this view keeps its committed slot and
  // restores in place (it vanished there; no reorder under the reader), while
  // cards archived before the view committed arrive behind the "N new" pill
  // like any other new content.
  const viewKey = `${workspaceId}|${lens}|${scope?.key ?? ""}|${types?.key ?? ""}|${excludeStreams?.key ?? ""}|${excludeTypes?.key ?? ""}|${labels?.key ?? ""}|${excludeLabels?.key ?? ""}|${unread?.key ?? ""}|${drafts?.key ?? ""}|${showArchived ? "arch" : ""}`
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

  // The seed gate is per-WORKSPACE, not per-view: once this workspace has
  // committed once, a lens/scope switch commits its new subset instantly even
  // while that view's query is still fetching. Switching workspace re-arms the
  // gate in the render phase, so the previous workspace's still-cached liveQuery
  // rows can never commit into the new workspace's view.
  const seedWorkspaceRef = useRef(workspaceId)
  const hasCommittedForWorkspaceRef = useRef(false)
  if (seedWorkspaceRef.current !== workspaceId) {
    seedWorkspaceRef.current = workspaceId
    hasCommittedForWorkspaceRef.current = false
  }

  // Fold the live feed into the committed view during render (deriving state from
  // props/inputs, not an effect — the render reads `committed`/`buffered` below,
  // so an effect would paint one frame stale). `setState` during render bails out
  // and re-renders synchronously; the equality guards keep it from looping once
  // converged.
  // Persisted IDB resolves in milliseconds, long before the network seed page
  // lands: committing then would freeze last session's feed and classify
  // everything created since as buffered ("N new" on a cold load).
  const seedNewest = seed?.newest ?? null
  const seedLanded =
    seed !== undefined &&
    seed.settled &&
    (seedNewest === null ||
      (rawLive?.some((post) => post.conversation.id === seedNewest.id && postMs(post) >= seedNewest.activityMs) ??
        false))
  const holdingForSeed = seed !== undefined && !seedLanded && !hasCommittedForWorkspaceRef.current
  if (live && !holdingForSeed) {
    liveRef.current = live
    for (const post of live) retainedRef.current.set(postId(post), post)
    // `reconcileStableView` reveals the viewer's own pending post (at top) and
    // paged-in older rows; only genuinely new conversations stay buffered.
    const next = reconcileStableView(committedInput, live)
    if (next.committed !== committedInput) {
      hasCommittedForWorkspaceRef.current = true
      setCommitted(next.committed)
    }
    if (!sameIds(bufferedInput, next.buffered)) setBuffered(next.buffered)
  }

  const commit = useCallback(() => {
    const snap = snapshot(liveRef.current)
    hasCommittedForWorkspaceRef.current = true
    setCommitted(snap)
    setBuffered([])
    const keep = new Set(snap.order)
    for (const id of [...retainedRef.current.keys()]) if (!keep.has(id)) retainedRef.current.delete(id)
  }, [])

  const { posts, removedIds, removedSuccessorById, draftResolvedIds } = useMemo(() => {
    const liveById = new Map((live ?? []).map((post) => [postId(post), post]))
    // Raw membership, not the filtered subset: a card the filters (or the
    // nested-view fold) dropped is still a real conversation, while one absent
    // from the raw feed was deleted out of IDB.
    const rawIds = rawLive ? new Set(rawLive.map(postId)) : null
    const out: CachedBoardPost[] = []
    const removed = new Set<string>()
    const gone = new Set<string>()
    const draftResolved = new Set<string>()
    for (const id of committed.order) {
      const post = liveById.get(id) ?? retainedRef.current.get(id)
      if (!post) continue
      // A committed card renders from `retainedRef` even after it leaves `live`,
      // so an involuntary drop (lost access, re-lensed by the viewer's own reply)
      // doesn't shift rows below it. But a VOLUNTARY hide/mute must drop NOW, not
      // wait for the next commit — so skip excluded ids here too, not just in the
      // `live` filter. (The retained copy is pruned on the next `commit()`.)
      // Clearing a card from the unread view is the same class of voluntary
      // action, and `matchesUnread` is where that verdict lives — reading a card
      // is NOT: the unread session's floor keeps it here (see
      // {@link BoardUnreadScope}).
      if (isExcluded(post)) continue
      if (!matchesUnread(post, unread)) continue
      // Resolving a draft is the viewer's own act on that card, so the drafts
      // view sheds it immediately — unlike reading in the unread view, which the
      // session floor holds in place. Emptying a checked-out draft is editing,
      // not resolving: membership holds (see {@link BoardDraftScope}).
      // Shedding goes through the REMOVAL path, never a drop from `posts`: the
      // draft resolves DURING the send (`resolveDraft` runs on submit and on
      // slash-command dispatch), so dropping the row here would unmount the
      // composer that is still sending, strand focus, and swallow the optimistic
      // reply. Retained + inert holds the subtree until the next commit().
      if (!matchesDrafts(post, drafts)) {
        draftResolved.add(id)
        removed.add(id)
      }
      if (rawIds !== null && !rawIds.has(id)) {
        gone.add(id)
        removed.add(id)
      }
      out.push(post)
    }
    // Successor resolution runs here, once, off the same raw feed — and only when
    // something was actually removed (the common case scans nothing).
    const successorById = new Map<string, RemovedSuccessor | null>()
    if (gone.size > 0 && rawLive) {
      const removedPosts = out.filter((post) => gone.has(postId(post)))
      for (const post of removedPosts) {
        const openingId = post.openingMessage?.id ?? null
        const successor = openingId
          ? (rawLive.find((row) => row.conversation.messageIds?.includes(openingId)) ?? null)
          : null
        successorById.set(
          postId(post),
          successor
            ? { conversationId: successor.conversation.id, topicSummary: successor.conversation.topicSummary ?? null }
            : null
        )
      }
    }
    return {
      posts: out,
      removedIds: removed as ReadonlySet<string>,
      removedSuccessorById: successorById as ReadonlyMap<string, RemovedSuccessor | null>,
      draftResolvedIds: draftResolved as ReadonlySet<string>,
    }
  }, [committed, live, rawLive, unread, drafts, isExcluded])

  return {
    posts,
    activityById: committed.activityById,
    newCount: buffered.length,
    commit,
    isLoading: live === undefined || holdingForSeed,
    hasRawPosts: (rawLive?.length ?? 0) > 0,
    removedIds,
    removedSuccessorById,
    draftResolvedIds,
  }
}
