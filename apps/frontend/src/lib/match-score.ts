/**
 * Tiered relevance scoring shared by suggestion surfaces (command palette,
 * slash commands, mention/channel triggers, emoji search).
 *
 * The first thing that decides a match is whether the query is a WHOLE word of
 * the text or a fragment of one. Whole-word hits all rank above every partial
 * hit, in either field, because a fragment is usually a coincidence: 😍
 * `heart_eyes` contains "yes" and ✅ carries it as a keyword, and only one of
 * those is an answer to `yes`.
 *
 * Within each group, a visible label ranks above a hidden keyword/alias, and a
 * hit that starts at the head of the text ranks above one that starts later:
 *
 *   whole word    0/4 exact                1/5 norm-exact
 *                 2/6 prefix               `no` in `no_entry`
 *                 3/7 word                 `eyes` in `heart_eyes`
 *   partial      8/13 prefix               `no` in `notebook`
 *               9/14 norm-prefix           `thumbsu` in `thumbs_up`
 *              10/15 word                  `eye` in `heart_eyes`
 *              11/16 anywhere              `ok` in `broken_heart`
 *              12/17 norm-anywhere
 *
 * (label tier / keyword tier.) "norm-" kinds compare with separators folded
 * (foldSeparators), so "thumbs up" and "thumbsup" hit "thumbs_up"; folding
 * erases the word boundaries, so a folded hit is never a whole-word kind.
 *
 * Below every substring tier come two tolerance bands, each reached only when
 * nothing above it matched, so they can add results but never displace one:
 *
 *   18/19  fuzzy subsequence, ordered by fuzzyQuality ("thup" → "thumbs_up")
 *   20/21  typo, ordered by edit distance ("thubms" → "thumbs_up")
 *
 * A query wrapped in double quotes is literal: it is graded on the same
 * ladder but only the un-normalized kinds can match it, and neither tolerance
 * band applies. Mirrors quoted phrases in message search.
 *
 * `scoreStreamMatch` (lib/stream-sort.ts) delegates here, so pickers,
 * the quick switcher and stream sort all order the same query identically.
 *
 * Lower score = better match; Infinity = no match.
 */

import { foldSeparators, fuzzyQuality, isWordEnd, isWordStart, typoBudget, typoDistance } from "@/lib/fuzzy"

/** Match kinds, ordered; the first WHOLE_WORD_KINDS of them cover whole words. */
const EXACT = 0
const NORM_EXACT = 1
const PREFIX_WHOLE_WORD = 2
const WORD_WHOLE_WORD = 3
const PREFIX_MID_WORD = 4
const NORM_PREFIX = 5
const WORD_MID_WORD = 6
const ANYWHERE = 7
const NORM_ANYWHERE = 8

const WHOLE_WORD_KINDS = 4
const PARTIAL_KINDS = 5
const PARTIAL_BAND = WHOLE_WORD_KINDS * 2

const LABEL_FUZZY_TIER = 18
const KEYWORD_FUZZY_TIER = 19
const LABEL_TYPO_TIER = 20
const KEYWORD_TYPO_TIER = 21

/** Place a match kind on the tier ladder for the field it was found in. */
function tierFor(kind: number, isKeyword: boolean): number {
  if (kind === Infinity) return Infinity
  if (kind < WHOLE_WORD_KINDS) return kind + (isKeyword ? WHOLE_WORD_KINDS : 0)
  return PARTIAL_BAND + (kind - WHOLE_WORD_KINDS) + (isKeyword ? PARTIAL_KINDS : 0)
}

/**
 * Fuzzy matches below this quality are rejected: compact abbreviation-style
 * matches ("thup" → "thumbs_up") score near 1, while a query scattered thinly
 * across a long sentence ("inv" → "Open a side-conversation") lands well
 * under it and would only add noise to the tail.
 */
const FUZZY_MIN_QUALITY = 0.7

interface ParsedQuery {
  /** Lowercased query text, quotes stripped. Empty means "not searching yet". */
  text: string
  /** Separator-folded `text`; empty when `text` is all separators. */
  normalized: string
  /** Quoted: match literally — no separator folding, no fuzzy, no typo. */
  literal: boolean
}

/**
 * Split a raw input into query text and its literal flag. A leading quote
 * counts even before the closing one is typed, so the half-typed `"yes` never
 * spends a keystroke matching the quote character itself.
 */
function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim()
  const literal = trimmed.startsWith('"')
  const unquoted = literal ? trimmed.replace(/^"/, "").replace(/"$/, "") : trimmed
  const text = unquoted.trim().toLowerCase()
  return { text, normalized: literal ? "" : foldSeparators(text), literal }
}

/**
 * Best kind over every occurrence of `needle` in `haystack`, ignoring the
 * exact-match kinds the caller has already ruled out. Infinity when absent.
 */
function occurrenceKind(haystack: string, needle: string): number {
  let best = Infinity
  if (haystack.startsWith(needle)) {
    if (isWordEnd(haystack, needle.length)) return PREFIX_WHOLE_WORD
    best = PREFIX_MID_WORD
  }
  // Only word starts can improve on that, and there are far fewer of them than
  // there are occurrences — walking words costs one pass over the text, while
  // enumerating every occurrence costs an indexOf per hit, which is what makes
  // a one-character query expensive across a dataset of thousands.
  for (let at = 1; at < haystack.length; at++) {
    if (!isWordStart(haystack, at) || !haystack.startsWith(needle, at)) continue
    if (isWordEnd(haystack, at + needle.length)) return WORD_WHOLE_WORD
    if (WORD_MID_WORD < best) best = WORD_MID_WORD
  }
  if (best !== Infinity) return best
  return haystack.includes(needle) ? ANYWHERE : Infinity
}

/** Match kind for one text, or Infinity. Lower is a stronger match. */
function matchKind(text: string, query: ParsedQuery): number {
  const lower = text.toLowerCase()
  if (lower === query.text) return EXACT
  const norm = query.normalized ? foldSeparators(lower) : ""
  if (norm && norm === query.normalized) return NORM_EXACT

  const raw = occurrenceKind(lower, query.text)
  if (raw === PREFIX_WHOLE_WORD || !norm) return raw
  // Folding erased the separators, so a folded hit has no word boundaries left
  // to grade and can never claim a whole-word kind: `no` folds into `notebook`
  // exactly as it folds into `no_entry`, and only the raw text tells them
  // apart. It grades one step below its raw counterpart.
  if (norm.startsWith(query.normalized)) return Math.min(raw, NORM_PREFIX)
  if (norm.includes(query.normalized)) return Math.min(raw, NORM_ANYWHERE)
  return raw
}

function bestKind(texts: readonly string[], query: ParsedQuery): number {
  let best = Infinity
  for (const text of texts) {
    const kind = matchKind(text, query)
    if (kind < best) best = kind
    if (best === EXACT) break
  }
  return best
}

function bestFuzzy(texts: readonly string[], normQuery: string): number {
  let best = 0
  for (const text of texts) {
    const quality = fuzzyQuality(normQuery, text)
    if (quality > best) best = quality
  }
  return best >= FUZZY_MIN_QUALITY ? best : 0
}

function bestTypoDistance(texts: readonly string[], query: string, budget: number): number {
  let best = budget + 1
  for (const text of texts) {
    const distance = typoDistance(query, text, budget)
    if (distance < best) best = distance
    if (best === 0) break
  }
  return best
}

export function scoreMatch(query: string, labels: readonly string[], keywords: readonly string[] = []): number {
  const parsed = parseQuery(query)
  // A whitespace- or quote-only query is "not searching yet", same as empty.
  if (!parsed.text) return 0

  const labelKind = bestKind(labels, parsed)
  if (labelKind === EXACT) return 0
  const keywordKind = bestKind(keywords, parsed)
  const best = Math.min(tierFor(labelKind, false), tierFor(keywordKind, true))
  if (best !== Infinity) return best
  // Any substring match outranks every tolerance match, so the bands below are
  // reached only when nothing matched at all. A literal query never reaches them.
  if (parsed.literal || !parsed.normalized) return Infinity

  const labelQuality = bestFuzzy(labels, parsed.normalized)
  if (labelQuality > 0) return LABEL_FUZZY_TIER + (1 - labelQuality)
  const keywordQuality = bestFuzzy(keywords, parsed.normalized)
  if (keywordQuality > 0) return KEYWORD_FUZZY_TIER + (1 - keywordQuality)

  const budget = typoBudget(parsed.text.length)
  if (budget <= 0) return Infinity
  const labelDistance = bestTypoDistance(labels, parsed.text, budget)
  if (labelDistance <= budget) return LABEL_TYPO_TIER + labelDistance / (budget + 1)
  const keywordDistance = bestTypoDistance(keywords, parsed.text, budget)
  if (keywordDistance <= budget) return KEYWORD_TYPO_TIER + keywordDistance / (budget + 1)
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
