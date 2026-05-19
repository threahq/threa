/**
 * B4 query-intent classification (gbrain concept B4, reframed for Threa).
 *
 * Deterministic and language-neutral: the only signals are query *structure*
 * (token count, presence of digit/date tokens), never natural-language word
 * lists, so it does not encode an English-only semantic heuristic (INV-54).
 * Its sole effect is to bend the keyword-vs-vector weights of the hybrid
 * search RRF fusion (B1) — a soft ranking nudge that never changes recall or
 * the access-scoped candidate set, so a crude classification can only reorder,
 * never leak.
 */
export type MemoQueryIntent = "entity" | "temporal" | "general"

export interface MemoQueryIntentResult {
  intent: MemoQueryIntent
  /** RRF weight for the keyword (full-text) list. */
  keywordWeight: number
  /** RRF weight for the semantic (vector) list. */
  semanticWeight: number
}

// Any Unicode decimal digit (dates, version numbers, ids). `\p{Nd}` keeps
// this script-neutral so non-ASCII numerals also count as temporal (INV-54).
const HAS_DIGITS = /\p{Nd}/u

export function classifyMemoQueryIntent(query: string): MemoQueryIntentResult {
  const trimmed = query.trim()
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/)

  if (HAS_DIGITS.test(trimmed)) {
    // Temporal / literal queries (dates, version numbers, ids) reward exact
    // keyword recall over fuzzy vector similarity.
    return { intent: "temporal", keywordWeight: 0.7, semanticWeight: 0.3 }
  }

  if (tokens.length > 0 && tokens.length <= 2) {
    // Short entity/topic lookups ("Stripe", "billing migration") reward
    // vector recall — the few keywords rarely full-text-match the abstract.
    return { intent: "entity", keywordWeight: 0.35, semanticWeight: 0.65 }
  }

  return { intent: "general", keywordWeight: 0.5, semanticWeight: 0.5 }
}
