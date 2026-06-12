/**
 * Tiered relevance scoring shared by suggestion surfaces (command palette,
 * slash commands, mention/channel triggers, emoji search).
 *
 * The problem this solves: pickers used to flat-filter with a boolean
 * substring test over "label + keywords", so an item matching only on a
 * hidden alias ranked identically to one whose visible label matched, and
 * definition order decided. Tiers encode WHERE the match landed: any visible
 * label match sorts above any hidden keyword match, and exact beats prefix
 * beats substring within each band. Mirrors the heuristic `scoreStreamMatch`
 * (lib/stream-sort.ts) already applies to streams.
 *
 * Lower score = better match; Infinity = no match.
 */

/** exact (0) < prefix (1) < contains (2), Infinity for no match. */
function scoreText(text: string, lowerQuery: string): number {
  const lower = text.toLowerCase()
  if (lower === lowerQuery) return 0
  if (lower.startsWith(lowerQuery)) return 1
  if (lower.includes(lowerQuery)) return 2
  return Infinity
}

/** Keyword tiers sit one whole band below label tiers (3/4/5 vs 0/1/2). */
const KEYWORD_TIER_OFFSET = 3

export function scoreMatch(query: string, labels: readonly string[], keywords: readonly string[] = []): number {
  if (!query) return 0
  const lowerQuery = query.toLowerCase()
  let best = Infinity
  for (const label of labels) {
    best = Math.min(best, scoreText(label, lowerQuery))
  }
  if (best === 0) return best
  for (const keyword of keywords) {
    best = Math.min(best, KEYWORD_TIER_OFFSET + scoreText(keyword, lowerQuery))
  }
  return best
}

/**
 * Filter and rank items by `scoreMatch`. Non-matches are dropped; ties keep
 * input order (sort is stable), so each surface's curated ordering still
 * breaks ties within a tier. An empty query returns the input unchanged.
 */
export function rankMatches<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => { labels: readonly string[]; keywords?: readonly string[] }
): T[] {
  if (!query) return [...items]
  return items
    .map((item) => {
      const { labels, keywords } = getText(item)
      return { item, score: scoreMatch(query, labels, keywords) }
    })
    .filter((entry) => entry.score !== Infinity)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item)
}
