import type { RenderableMessage } from "@/components/message/message-item"

/**
 * The one same-author-run rule. A "run" is what a person types as a single
 * thought: consecutive rows by the same actor inside
 * {@link AUTHOR_RUN_WINDOW_MS}. The timeline collapses a run's tail rows into
 * headerless continuations; the board's card tail counts runs, not rows.
 *
 * Two surfaces consumed this rule with their own constant and their own
 * predicate before this module (`isContinuation`, formerly in `message-item.tsx`,
 * and `annotateAuthorGroups` in `event-list.tsx`). They differed in two details,
 * preserved here through the adapters rather than silently reconciled:
 *
 * - **Boundary.** The timeline groups at exactly the window (`<=`); the
 *   message row groups strictly inside it (`<`). Callers pick via
 *   `boundary`. One millisecond apart, but the timeline's grouping must stay
 *   byte-identical.
 * - **Row order.** The timeline compares signed elapsed time — its items are
 *   chronological by construction. The message row compared absolute elapsed
 *   time, so an out-of-order pair could not group across a wide gap. Its
 *   adapter orders the pair before calling, which reproduces that.
 *
 * Deleted rows break a run on both surfaces, expressed here as `breaksRun`.
 */

/** Same-actor rows this close together belong to one run. */
export const AUTHOR_RUN_WINDOW_MS = 5 * 60_000

/** The minimal facts a run boundary depends on. */
export interface AuthorRunRow {
  /** Nullable because a stream event's actor is (system rows); two null actors
   *  compare equal, matching the timeline's long-standing behavior. */
  authorId: string | null
  authorType: string | null
  createdAtMs: number
  /** A tombstone/placeholder row: never groups, and breaks the run around it. */
  breaksRun?: boolean
}

export interface AuthorRunOptions {
  /** `"inclusive"` (default) groups at exactly {@link AUTHOR_RUN_WINDOW_MS}. */
  boundary?: "inclusive" | "exclusive"
}

export function isSameAuthorRun(prev: AuthorRunRow, next: AuthorRunRow, options: AuthorRunOptions = {}): boolean {
  if (prev.breaksRun || next.breaksRun) return false
  if (prev.authorId !== next.authorId || prev.authorType !== next.authorType) return false
  const elapsed = next.createdAtMs - prev.createdAtMs
  return options.boundary === "exclusive" ? elapsed < AUTHOR_RUN_WINDOW_MS : elapsed <= AUTHOR_RUN_WINDOW_MS
}

/** The message row's adapter onto the run rule: absolute elapsed time (the pair
 *  is ordered before comparing) and a strict window boundary. */
export function isContinuation(prev: RenderableMessage, cur: RenderableMessage): boolean {
  const a = toRunRow(prev)
  const b = toRunRow(cur)
  const [earlier, later] = a.createdAtMs <= b.createdAtMs ? [a, b] : [b, a]
  return isSameAuthorRun(earlier, later, { boundary: "exclusive" })
}

function toRunRow(message: RenderableMessage): AuthorRunRow {
  return {
    authorId: message.authorId,
    authorType: message.authorType,
    createdAtMs: new Date(message.createdAt).getTime(),
    breaksRun: Boolean(message.deletedAt),
  }
}
