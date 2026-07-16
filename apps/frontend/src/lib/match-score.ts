/**
 * Tiered relevance scoring shared by suggestion surfaces (command palette,
 * slash commands, mention/channel triggers, emoji search).
 *
 * The problem this solves: pickers used to flat-filter with a boolean
 * substring test over "label + keywords", so an item matching only on a
 * hidden alias ranked identically to one whose visible label matched, and
 * definition order decided. Tiers encode WHERE and HOW the match landed:
 *
 *   labels, substring family   0..5   exact < norm-exact < prefix <
 *                                     norm-prefix < contains < norm-contains
 *   keywords, substring family 6..11  same ladder, one band below
 *   labels, fuzzy subsequence  12..13 ordered by fuzzyQuality within the band
 *   keywords, fuzzy            13..14
 *
 * "norm-" tiers compare with separators folded (foldSeparators), so
 * "thumbs up" and "thumbsup" hit "thumbs_up". Fuzzy tiers admit in-order
 * subsequences ("thup" → "thumbs_up") but always rank below every substring
 * match, so the fuzzy tail can only add results, never displace them.
 * Mirrors `scoreStreamMatch` (lib/stream-sort.ts), which delegates here.
 *
 * Lower score = better match; Infinity = no match.
 */

import { foldSeparators, fuzzyQuality } from "@/lib/fuzzy"

/** exact (0) < norm-exact (1) < prefix (2) < norm-prefix (3) < contains (4) < norm-contains (5). */
function scoreText(text: string, lowerQuery: string, normQuery: string): number {
  const lower = text.toLowerCase()
  if (lower === lowerQuery) return 0
  const norm = foldSeparators(lower)
  if (normQuery && norm === normQuery) return 1
  if (lower.startsWith(lowerQuery)) return 2
  if (normQuery && norm.startsWith(normQuery)) return 3
  if (lower.includes(lowerQuery)) return 4
  if (normQuery && norm.includes(normQuery)) return 5
  return Infinity
}

/** Keyword substring tiers sit one whole band below label tiers (6..11 vs 0..5). */
const KEYWORD_TIER_OFFSET = 6
const LABEL_FUZZY_TIER = 12
const KEYWORD_FUZZY_TIER = 13

/**
 * Fuzzy matches below this quality are rejected: compact abbreviation-style
 * matches ("thup" → "thumbs_up") score near 1, while a query scattered thinly
 * across a long sentence ("inv" → "Open a side-conversation") lands well
 * under it and would only add noise to the tail.
 */
const FUZZY_MIN_QUALITY = 0.7

function bestFuzzy(texts: readonly string[], normQuery: string): number {
  let best = 0
  for (const text of texts) {
    const quality = fuzzyQuality(normQuery, text)
    if (quality > best) best = quality
  }
  return best >= FUZZY_MIN_QUALITY ? best : 0
}

export function scoreMatch(query: string, labels: readonly string[], keywords: readonly string[] = []): number {
  // A whitespace-only query is "not searching yet", same as empty — without
  // the trim it would fold to an empty normQuery and match nothing at all.
  const lowerQuery = query.trim().toLowerCase()
  if (!lowerQuery) return 0
  const normQuery = foldSeparators(lowerQuery)
  let best = Infinity
  for (const label of labels) {
    best = Math.min(best, scoreText(label, lowerQuery, normQuery))
  }
  if (best === 0) return best
  for (const keyword of keywords) {
    best = Math.min(best, KEYWORD_TIER_OFFSET + scoreText(keyword, lowerQuery, normQuery))
  }
  // Any substring match outranks every fuzzy match, so only fall through when
  // nothing matched at all.
  if (best !== Infinity || !normQuery) return best
  const labelQuality = bestFuzzy(labels, normQuery)
  if (labelQuality > 0) return LABEL_FUZZY_TIER + (1 - labelQuality)
  const keywordQuality = bestFuzzy(keywords, normQuery)
  if (keywordQuality > 0) return KEYWORD_FUZZY_TIER + (1 - keywordQuality)
  return Infinity
}

/**
 * Filter and rank items by `scoreMatch`. Non-matches are dropped; ties keep
 * input order (sort is stable), so each surface's curated ordering still
 * breaks ties within a tier. An empty or whitespace-only query returns the
 * input unchanged.
 */
export function rankMatches<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => { labels: readonly string[]; keywords?: readonly string[] }
): T[] {
  if (!query.trim()) return [...items]
  return items
    .map((item) => {
      const { labels, keywords } = getText(item)
      return { item, score: scoreMatch(query, labels, keywords) }
    })
    .filter((entry) => entry.score !== Infinity)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item)
}
