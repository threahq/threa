/**
 * Separator-insensitive fuzzy matching primitives shared by the suggestion
 * scorers (lib/match-score.ts, lib/stream-sort.ts).
 *
 * Two building blocks:
 * - `foldSeparators` makes whitespace/underscore/dash interchangeable, so
 *   "thumbs up", "thumbs-up", and "thumbs_up" all compare equal.
 * - `fuzzyQuality` scores an in-order subsequence match, rewarding contiguous
 *   runs and word-boundary starts so "thup" → "thumbs_up" scores well while
 *   scattered matches sink.
 */

const SEPARATOR = /[\s_-]/
const SEPARATORS = /[\s_-]+/g

/** Lowercased text with whitespace/underscore/dash removed. */
export function foldSeparators(text: string): string {
  return text.replace(SEPARATORS, "")
}

function isBoundary(text: string, index: number): boolean {
  return index === 0 || SEPARATOR.test(text[index - 1])
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
      const bonus = isBoundary(lower, j) ? 1 : 0
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
