/**
 * Separator-insensitive fuzzy matching primitives shared by the suggestion
 * scorers (lib/match-score.ts, lib/stream-sort.ts).
 *
 * Three building blocks:
 * - `foldSeparators` makes whitespace/underscore/dash interchangeable, so
 *   "thumbs up", "thumbs-up", and "thumbs_up" all compare equal.
 * - `fuzzyQuality` scores an in-order subsequence match, rewarding contiguous
 *   runs and word-boundary starts so "thup" → "thumbs_up" scores well while
 *   scattered matches sink.
 * - `typoDistance` scores a mistyped query by edit distance, catching the
 *   errors a subsequence cannot represent at any threshold (transposition,
 *   substitution, insertion): "thubms" → "thumbs_up".
 */

const FOLDED_SEPARATORS = /[\s_-]+/g
const TOKEN_SPLIT = /[\s_:-]+/

/**
 * Character-code twin of TOKEN_SPLIT. These predicates run once per character
 * of every candidate string, and a regex test there costs more than the
 * matching it guards — hence the codes rather than `SEPARATOR.test(text[i])`.
 */
function isSeparatorCode(code: number): boolean {
  return (
    code === 32 || // space
    code === 95 || // _
    code === 45 || // -
    code === 58 || // :
    (code >= 9 && code <= 13) || // tab, newline, vertical tab, form feed, carriage return
    code === 0xa0 // non-breaking space
  )
}

/** Lowercased text with whitespace/underscore/dash removed. */
export function foldSeparators(text: string): string {
  return text.replace(FOLDED_SEPARATORS, "")
}

/** Lowercased words of `text`, split on whitespace/underscore/dash/colon. */
export function splitTokens(text: string): string[] {
  return text.toLowerCase().split(TOKEN_SPLIT).filter(Boolean)
}

/** Whether index `index` begins a word (start of text, or after a separator). */
export function isWordStart(text: string, index: number): boolean {
  return index === 0 || isSeparatorCode(text.charCodeAt(index - 1))
}

/** Whether index `index` ends a word (end of text, or a separator sits there). */
export function isWordEnd(text: string, index: number): boolean {
  return index === text.length || isSeparatorCode(text.charCodeAt(index))
}

/** Whether `query` appears in `lowerText` in order, gaps allowed. */
function isSubsequence(query: string, lowerText: string): boolean {
  let at = 0
  for (let i = 0; i < lowerText.length && at < query.length; i++) {
    if (lowerText[i] === query[at]) at++
  }
  return at === query.length
}

/**
 * Subsequence match quality in (0, 1]; 0 when `query` is not an in-order
 * subsequence of `text`. Expects a lowercased, separator-folded query; the
 * text keeps its separators so boundary bonuses can see them.
 *
 * Each matched char scores 1, plus 1 when it extends a contiguous run or sits
 * at a word boundary; quality is the best total over all alignments divided
 * by the maximum (2 per query char).
 */
export function fuzzyQuality(query: string, text: string): number {
  const m = query.length
  const n = text.length
  if (m === 0 || m > n) return 0
  const lower = text.toLowerCase()
  // The DP below allocates a row per query character, so it must not run for
  // the overwhelming majority of candidates that cannot match at all. A linear
  // subsequence test decides that with no allocation.
  if (!isSubsequence(query, lower)) return 0

  // endAt[j]: best score for the query prefix so far with its last char
  // matched exactly at text index j; -1 when unreachable.
  let endAt: number[] = new Array(n).fill(-1)
  for (let i = 0; i < m; i++) {
    const qc = query[i]
    const next: number[] = new Array(n).fill(-1)
    let bestBefore = -1
    for (let j = 0; j < n; j++) {
      if (i > 0 && j > 0 && endAt[j - 1] > bestBefore) bestBefore = endAt[j - 1]
      if (lower[j] !== qc) continue
      const bonus = isWordStart(lower, j) ? 1 : 0
      if (i === 0) {
        next[j] = 1 + bonus
        continue
      }
      const contiguous = j > 0 && endAt[j - 1] >= 0 ? endAt[j - 1] + 2 : -1
      const gapped = bestBefore >= 0 ? bestBefore + 1 + bonus : -1
      next[j] = Math.max(contiguous, gapped)
    }
    endAt = next
  }

  let best = -1
  for (const score of endAt) {
    if (score > best) best = score
  }
  return best > 0 ? best / (2 * m) : 0
}

/**
 * Edit operations a query of this length may be off by. Below 4 characters the
 * budget is 0: at that length one edit reaches so much of any real dataset that
 * the tier stops ranking and starts listing (a 3-char query admitting distance
 * 1 matched a third of the emoji set in testing).
 */
export function typoBudget(queryLength: number): number {
  if (queryLength < 4) return 0
  if (queryLength < 8) return 1
  return 2
}

/**
 * Damerau-Levenshtein distance between `a` and `b`, capped: any distance above
 * `budget` returns `budget + 1` rather than the true value. The cap is what
 * makes this affordable to run across a whole dataset — the length-difference
 * check rejects most candidates before any DP work, and the per-row minimum
 * bails out of the rest.
 *
 * Damerau (adjacent transposition as one edit) rather than plain Levenshtein:
 * transposition is the most common typing error and the one a subsequence
 * match can never admit, so it is the whole reason this function exists.
 */
/**
 * Bitmask of the a-z characters present in `text[from, to)`; characters
 * outside a-z all share the 27th bit, which only ever makes the gate more
 * permissive.
 */
function characterMask(text: string, from: number, to: number): number {
  let mask = 0
  for (let i = from; i < to; i++) {
    const code = text.charCodeAt(i) - 97
    mask |= code >= 0 && code < 26 ? 1 << code : 1 << 26
  }
  return mask
}

const dpRows: Int32Array[] = [new Int32Array(64), new Int32Array(64), new Int32Array(64)]

/** One of the three shared DP rows, grown if this comparison needs a longer one. */
function rowBuffer(index: number, length: number): Int32Array {
  if (dpRows[index].length < length) dpRows[index] = new Int32Array(length)
  return dpRows[index]
}

function popcount(bits: number): number {
  let n = bits - ((bits >> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333)
  n = (n + (n >> 4)) & 0x0f0f0f0f
  return (n * 0x01010101) >> 24
}

function damerauLevenshtein(a: string, b: string, from: number, to: number, budget: number, aMask: number): number {
  const m = a.length
  const n = to - from
  if (Math.abs(m - n) > budget) return budget + 1
  if (m === 0) return n
  if (n === 0) return m
  // Every character of `a` absent from `b` costs at least one edit, so a
  // set-difference wider than the budget rules the pair out before any DP.
  if (popcount(aMask & ~characterMask(b, from, to)) > budget) return budget + 1

  // Three rotating rows, allocated once for the whole module: this DP runs
  // thousands of times per keystroke and fresh rows per row per call were the
  // dominant cost.
  let beforePrev = rowBuffer(0, n + 1)
  let prev = rowBuffer(1, n + 1)
  let row = rowBuffer(2, n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= m; i++) {
    row[0] = i
    let rowMin = i
    for (let j = 1; j <= n; j++) {
      const bj = b[from + j - 1]
      const cost = a[i - 1] === bj ? 0 : 1
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[from + j - 2] && a[i - 2] === bj) {
        value = Math.min(value, beforePrev[j - 2] + 1)
      }
      row[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > budget) return budget + 1
    const spent = beforePrev
    beforePrev = prev
    prev = row
    row = spent
  }
  return prev[n]
}

/**
 * Best edit distance from `query` to `text` as a whole or to any one of its
 * tokens, capped at `budget + 1` (i.e. "no match").
 *
 * Anchoring to whole tokens rather than to any substring window is what keeps
 * the tier honest: an unanchored substring distance lets a 4-character query
 * land within one edit of *some* window of every long label, which reads as
 * the picker having stopped filtering.
 */
export function typoDistance(query: string, text: string, budget: number): number {
  if (budget <= 0 || !query) return budget + 1
  const lower = text.toLowerCase()
  const queryMask = characterMask(query, 0, query.length)
  let best = damerauLevenshtein(query, lower, 0, lower.length, budget, queryMask)
  if (best === 0) return 0
  // Walk the token spans in place rather than through splitTokens: this runs
  // once per candidate string in a dataset of thousands, and the array of
  // slices it would allocate dominates the DP it feeds.
  for (let start = 0; start < lower.length; ) {
    if (isSeparatorCode(lower.charCodeAt(start))) {
      start++
      continue
    }
    let end = start + 1
    while (end < lower.length && !isSeparatorCode(lower.charCodeAt(end))) end++
    const distance = damerauLevenshtein(query, lower, start, end, budget, queryMask)
    if (distance < best) best = distance
    if (best === 0) return 0
    start = end + 1
  }
  return best
}
