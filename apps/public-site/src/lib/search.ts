type SearchKind = "page" | "heading" | "operation" | "field"

export interface SearchEntry {
  kind: SearchKind
  title: string
  url: string
  /** Where the hit lives, shown under the title ("Field on Send a message request body"). */
  where: string
  /** Other names the entry answers to (operationId, "POST /path", a page's h1). */
  aliases?: string[]
  /** Surrounding names (group, endpoint, parent field). A query token found only here ranks lowest. */
  context?: string[]
  method?: string
  path?: string
}

export const MAX_RESULTS = 20

const TIER = {
  exact: 4,
  exactWords: 3,
  wordPrefix: 2,
  substring: 1,
  contextOnly: 0.5,
} as const

const KIND_RANK: Record<SearchKind, number> = { page: 0, heading: 1, operation: 2, field: 3 }

interface Analyzed {
  /** Lowercased letters and digits only: "createOrder" and "create_order" both become "createorder". */
  compact: string
  /** Offsets in `compact` where a word begins (camelCase humps, separators). */
  starts: number[]
  /** Offset in the original text of each `compact` character. */
  origin: number[]
}

const isAlnum = (c: string) => /[\p{L}\p{N}]/u.test(c)
const isUpper = (c: string) => /\p{Lu}/u.test(c)
const isLowerOrDigit = (c: string) => /[\p{Ll}\p{N}]/u.test(c)

function analyze(text: string): Analyzed {
  const chars = Array.from(text)
  const out: Analyzed = { compact: "", starts: [], origin: [] }
  let offset = 0
  let prev = ""
  chars.forEach((c, i) => {
    const at = offset
    offset += c.length
    if (!isAlnum(c)) {
      prev = ""
      return
    }
    const next = chars[i + 1] ?? ""
    const boundary =
      prev === "" || (isLowerOrDigit(prev) && isUpper(c)) || (isUpper(prev) && isUpper(c) && /\p{Ll}/u.test(next))
    if (boundary) out.starts.push(out.compact.length)
    for (const lower of c.toLowerCase()) {
      out.compact += lower
      out.origin.push(at)
    }
    prev = c
  })
  return out
}

export function splitWords(text: string): string[] {
  const { compact, starts } = analyze(text)
  return starts.map((s, i) => compact.slice(s, starts[i + 1] ?? compact.length))
}

/* Where `token` sits in `term`, best first: a whole run of words, the start of
   a word, anywhere. Returns the tier and the matched span in `compact`. */
function locate(token: string, term: Analyzed): { tier: number; at: number } | null {
  let prefixAt = -1
  for (const s of term.starts) {
    if (!term.compact.startsWith(token, s)) continue
    const end = s + token.length
    if (end === term.compact.length || term.starts.includes(end)) return { tier: TIER.exactWords, at: s }
    if (prefixAt < 0) prefixAt = s
  }
  if (prefixAt >= 0) return { tier: TIER.wordPrefix, at: prefixAt }
  const at = term.compact.indexOf(token)
  return at >= 0 ? { tier: TIER.substring, at } : null
}

export interface PreparedEntry {
  entry: SearchEntry
  order: number
  terms: Analyzed[]
  context: Analyzed[]
}

export function prepareIndex(entries: SearchEntry[]): PreparedEntry[] {
  return entries.map((entry, order) => ({
    entry,
    order,
    terms: [entry.title, ...(entry.aliases ?? [])].map(analyze),
    context: (entry.context ?? []).map(analyze),
  }))
}

const bestTier = (token: string, terms: Analyzed[]) =>
  terms.reduce((best, term) => Math.max(best, locate(token, term)?.tier ?? 0), 0)

/* The entry's tier for a query, or 0 when it doesn't match. Every token must
   match somewhere, and at least one in the entry's own names: a query that
   only hits the surrounding context would return every field of an endpoint. */
function scoreEntry(prepared: PreparedEntry, tokens: string[]): number {
  const joined = tokens.join("")
  if (prepared.terms.some((t) => t.compact === joined)) return TIER.exact

  let tier: number = TIER.exact
  let ownHit = false
  for (const token of tokens) {
    const own = bestTier(token, prepared.terms)
    if (own > 0) {
      ownHit = true
      tier = Math.min(tier, own)
      continue
    }
    if (bestTier(token, prepared.context) === 0) {
      tier = 0
      break
    }
    tier = Math.min(tier, TIER.contextOnly)
  }
  if (tier > 0 && ownHit) return tier

  // "creat eorder": tokens that miss one by one can still name the entry once joined.
  return tokens.length > 1 ? bestTier(joined, prepared.terms) : 0
}

export interface SearchHit {
  entry: SearchEntry
  tier: number
}

export function search(index: PreparedEntry[], query: string, limit = MAX_RESULTS): SearchHit[] {
  const tokens = splitWords(query)
  if (tokens.length === 0) return []
  const scored: { prepared: PreparedEntry; tier: number }[] = []
  for (const prepared of index) {
    const tier = scoreEntry(prepared, tokens)
    if (tier > 0) scored.push({ prepared, tier })
  }
  scored.sort(
    (a, b) =>
      b.tier - a.tier ||
      KIND_RANK[a.prepared.entry.kind] - KIND_RANK[b.prepared.entry.kind] ||
      a.prepared.entry.title.length - b.prepared.entry.title.length ||
      a.prepared.order - b.prepared.order
  )
  return scored.slice(0, limit).map(({ prepared, tier }) => ({ entry: prepared.entry, tier }))
}

/* Character ranges in `text` to mark for `query`, merged and sorted. */
export function highlightRanges(text: string, query: string): [number, number][] {
  const tokens = splitWords(query)
  if (tokens.length === 0) return []
  const term = analyze(text)
  const whole = tokens.join("")
  const found = tokens.length > 1 ? locate(whole, term) : null
  const spans = found ? [{ at: found.at, length: whole.length }] : []
  if (!found) {
    for (const token of tokens) {
      const hit = locate(token, term)
      if (hit) spans.push({ at: hit.at, length: token.length })
    }
  }

  const ranges = spans.map(({ at, length }): [number, number] => {
    const last = term.origin[at + length - 1]
    return [term.origin[at], last + String.fromCodePoint(text.codePointAt(last)!).length]
  })
  ranges.sort((a, b) => a[0] - b[0])
  return ranges.reduce<[number, number][]>((merged, r) => {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push(r)
    return merged
  }, [])
}
