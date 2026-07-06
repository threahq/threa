import type { CachedBoardPost } from "@/db"

/**
 * Fold a lens/scope-filtered board feed into one card per root discussion
 * (board-view-design.md § "Nested threads × conversations", corrected
 * 2026-07-05). A conversation whose anchor thread forks off a member message of
 * another conversation is a **branch** rendered inside that parent's card, so it
 * is suppressed from the top-level list — but only when its parent is itself
 * present in the same filtered list. A child whose parent is filtered out or
 * inaccessible stays standalone: content never vanishes.
 *
 * Pure: the branch relationship is supplied as `parentIdOf` (the graph-only walk
 * primitive `branchParentConversationId`), so this stays testable without hooks.
 *
 * Two folds happen alongside suppression, both on **shallow copies** — the cached
 * IDB rows are never mutated:
 *
 *  - **Effective activity.** A surviving parent inherits the max `_lastActivityMs`
 *    of the branches folding into it, so a branch reply bumps the parent card for
 *    ordering (`reconcileStableView`/`postMs` read the copied `lastActivityAt`).
 *  - **Declared streams.** A survivor's `streamIds` gains its folded children's
 *    streams, so the board page's `useBoardStreamSubscriptions` (and the card's
 *    visible-streams declaration) still catch up + join the suppressed branches'
 *    thread rooms — otherwise a branch nobody joined would never sync.
 *
 * Suppression is transitive: a grandchild whose parent is also suppressed folds
 * to the nearest **present** ancestor's card. Survivors are returned newest
 * effective-activity first so the committed snapshot orders on the fold.
 */
export function projectNestedBoardView(
  posts: CachedBoardPost[],
  parentIdOf: (conversationId: string) => string | null
): CachedBoardPost[] {
  if (posts.length === 0) return posts
  const present = new Set(posts.map((post) => post.conversation.id))

  // The nearest ancestor present in the filtered list, walking branch parents.
  // Cycle-guarded so a corrupt graph can't spin. `null` ⇒ this post survives.
  const nearestPresentAncestor = (id: string): string | null => {
    const seen = new Set<string>([id])
    let current = parentIdOf(id)
    while (current && !seen.has(current)) {
      if (present.has(current)) return current
      seen.add(current)
      current = parentIdOf(current)
    }
    return null
  }

  // Two passes: suppression depends only on presence, but the fold target must
  // be the nearest SURVIVING ancestor — in a present chain A ← B ← C, B folds
  // into A and so must C (B's card never renders), or C's activity bump and
  // stream declarations would fold into a suppressed post and be dropped.
  const suppressed = new Set<string>()
  for (const post of posts) {
    if (nearestPresentAncestor(post.conversation.id)) suppressed.add(post.conversation.id)
  }

  const nearestSurvivingAncestor = (id: string): string | null => {
    const seen = new Set<string>([id])
    let current = parentIdOf(id)
    while (current && !seen.has(current)) {
      if (present.has(current) && !suppressed.has(current)) return current
      seen.add(current)
      current = parentIdOf(current)
    }
    return null
  }

  const effectiveMs = new Map<string, number>()
  const foldedStreams = new Map<string, Set<string>>()
  for (const post of posts) {
    const id = post.conversation.id
    if (!suppressed.has(id)) continue
    const ancestor = nearestSurvivingAncestor(id)
    if (!ancestor) continue
    effectiveMs.set(ancestor, Math.max(effectiveMs.get(ancestor) ?? Number.NEGATIVE_INFINITY, post._lastActivityMs))
    let streams = foldedStreams.get(ancestor)
    if (!streams) {
      streams = new Set<string>()
      foldedStreams.set(ancestor, streams)
    }
    streams.add(post.conversation.streamId)
    for (const streamId of post.streamIds ?? []) streams.add(streamId)
  }

  const survivors: CachedBoardPost[] = []
  for (const post of posts) {
    const id = post.conversation.id
    if (suppressed.has(id)) continue
    const bumpedMs = effectiveMs.get(id)
    const folded = foldedStreams.get(id)
    if (bumpedMs === undefined && !folded) {
      survivors.push(post)
      continue
    }
    const streamIds = folded ? [...new Set([...(post.streamIds ?? []), ...folded])] : post.streamIds
    const eff = bumpedMs !== undefined && bumpedMs > post._lastActivityMs ? bumpedMs : post._lastActivityMs
    survivors.push(
      eff > post._lastActivityMs
        ? {
            ...post,
            _lastActivityMs: eff,
            streamIds,
            conversation: { ...post.conversation, lastActivityAt: new Date(eff).toISOString() },
          }
        : { ...post, streamIds }
    )
  }

  // Effective-activity desc; V8's stable sort keeps the input's (already
  // activity-desc) order for ties, so only a bumped parent moves.
  survivors.sort((a, b) => b._lastActivityMs - a._lastActivityMs)
  return survivors
}
