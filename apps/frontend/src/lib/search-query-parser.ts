/**
 * Parse and serialize search queries with filter support.
 *
 * Supports filters: from:@user, with:@user, in:#channel, in:@user (DM), is:streamType, type:streamType (alias), status:archiveStatus, after:date, before:date
 */
import {
  MAX_SEARCH_REFINES,
  MAX_SEARCH_REFINE_CHARS,
  SEARCH_REFINEMENT_KINDS,
  type SearchRefinement,
  type SearchRefinementKind,
} from "@threahq/types"

export type FilterType = "from" | "with" | "in" | "type" | "status" | "after" | "before"

export interface ParsedFilter {
  type: FilterType
  value: string
  /** Original text in the query (e.g., "from:@martin") */
  raw: string
}

export interface ParsedQuery {
  filters: ParsedFilter[]
  text: string
  phrases: string[]
  semanticText: string
}

/**
 * Parse a search query string into filters and remaining text.
 *
 * Examples:
 * - "from:@martin hello" → { filters: [{type: "from", value: "martin"}], text: "hello" }
 * - "in:#general is:thread" → { filters: [{type: "in", value: "general"}, {type: "type", value: "thread"}], text: "" }
 * - "status:archived bug" → { filters: [{type: "status", value: "archived"}], text: "bug" }
 * - "is:scratchpad bug" → { filters: [{type: "type", value: "scratchpad"}], text: "bug" }
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const filters: ParsedFilter[] = []
  const textParts: string[] = []
  const semanticParts: string[] = []
  const filterRegex = /\b(from:@|with:@|in:#|in:@|type:|status:|is:|after:|before:)(\S*)/g
  const phraseRegex = /["“]([^"“”]+)["”]/g

  const parseSegment = (segment: string) => {
    let lastIndex = 0
    let match: RegExpExecArray | null
    filterRegex.lastIndex = 0

    while ((match = filterRegex.exec(segment)) !== null) {
      if (match.index > lastIndex) {
        const plainText = segment.slice(lastIndex, match.index)
        textParts.push(plainText)
        semanticParts.push(plainText)
      }

      const [raw, prefix, value] = match
      const type = extractFilterType(prefix)
      if (type && value) {
        filters.push({ type, value, raw })
      } else {
        textParts.push(raw)
        semanticParts.push(raw)
      }
      lastIndex = match.index + raw.length
    }

    if (lastIndex < segment.length) {
      const plainText = segment.slice(lastIndex)
      textParts.push(plainText)
      semanticParts.push(plainText)
    }
  }

  const phrases: string[] = []
  let lastIndex = 0
  let phraseMatch: RegExpExecArray | null
  while ((phraseMatch = phraseRegex.exec(query)) !== null) {
    parseSegment(query.slice(lastIndex, phraseMatch.index))
    textParts.push(phraseMatch[0])
    semanticParts.push(" ")
    phrases.push(phraseMatch[1])
    lastIndex = phraseMatch.index + phraseMatch[0].length
  }
  parseSegment(query.slice(lastIndex))

  const normalize = (parts: string[]) => parts.join("").trim().replace(/\s+/g, " ")
  return { filters, text: normalize(textParts), phrases, semanticText: normalize(semanticParts) }
}

function extractFilterType(prefix: string): FilterType | null {
  switch (prefix) {
    case "from:@":
      return "from"
    case "with:@":
      return "with"
    case "in:#":
    case "in:@":
      return "in"
    case "type:":
      return "type"
    case "status:":
      return "status"
    case "is:":
      return "type"
    case "after:":
      return "after"
    case "before:":
      return "before"
    default:
      return null
  }
}

/**
 * Build a search query string from filters and text.
 */
export function serializeSearchQuery(filters: ParsedFilter[], text: string): string {
  const filterParts = filters.map((f) => f.raw)
  const parts = [...filterParts]

  if (text.trim()) {
    parts.push(text.trim())
  }

  return parts.join(" ")
}

/**
 * Remove a filter from the query string.
 */
export function removeFilterFromQuery(query: string, filterIndex: number): string {
  const { filters, text } = parseSearchQuery(query)
  const newFilters = filters.filter((_, i) => i !== filterIndex)
  return serializeSearchQuery(newFilters, text)
}

/**
 * The refine trail the backend accepts: prose trimmed, non-empty and within the
 * length cap, row refinements carrying a conversation, and only the newest
 * `MAX_SEARCH_REFINES`. Applied when a refine is committed and when a trail is
 * restored from a URL, so both shapes are validated in one place.
 */
export function boundRefines(refines: SearchRefinement[]): SearchRefinement[] {
  return refines.flatMap((refine) => parseRefine(refine) ?? []).slice(-MAX_SEARCH_REFINES)
}

/**
 * One refinement as it travels in a URL (`?refine=`): `more:conv_x` /
 * `drop:conv_x` name a row, anything else is prose. Returns null for a value
 * the backend would reject.
 */
export function parseRefine(refine: SearchRefinement): SearchRefinement | null {
  if (typeof refine !== "string") {
    return refine.conversationId.length > 0 ? refine : null
  }
  const row = ROW_REFINE_PATTERN.exec(refine)
  if (row) {
    const kind = row[1] as SearchRefinementKind
    return { kind, conversationId: row[2]! }
  }
  const prose = refine.trim()
  return prose.length > 0 && prose.length <= MAX_SEARCH_REFINE_CHARS ? prose : null
}

/**
 * Only a conversation id after the kind, so prose the user typed as "drop:
 * anything from Bob" stays prose (INV-2 prefixed ids, no spaces).
 */
const ROW_REFINE_PATTERN = new RegExp(`^(${SEARCH_REFINEMENT_KINDS.join("|")}):(conv_[A-Za-z0-9]+)$`)

/** The inverse of {@link parseRefine}: what a `?refine=` param carries. */
export function serializeRefine(refine: SearchRefinement): string {
  return typeof refine === "string" ? refine : `${refine.kind}:${refine.conversationId}`
}

/**
 * Add a filter to the query string.
 */
export function addFilterToQuery(query: string, type: FilterType, value: string): string {
  const { filters, text } = parseSearchQuery(query)

  let raw: string
  switch (type) {
    case "from":
      raw = `from:@${value}`
      break
    case "with":
      raw = `with:@${value}`
      break
    case "in":
      raw = value.startsWith("#") ? `in:${value}` : `in:@${value}`
      break
    case "type":
      raw = `is:${value}`
      break
    case "status":
      raw = `status:${value}`
      break
    case "after":
      raw = `after:${value}`
      break
    case "before":
      raw = `before:${value}`
      break
  }

  const newFilter: ParsedFilter = { type, value, raw }
  return serializeSearchQuery([...filters, newFilter], text)
}

/**
 * Get display label for a filter value.
 */
export function getFilterLabel(filter: ParsedFilter): string {
  switch (filter.type) {
    case "from":
      return `@${filter.value}`
    case "with":
      return `@${filter.value}`
    case "in":
      return filter.raw.startsWith("in:#") ? `#${filter.value}` : `@${filter.value}`
    case "type":
      return filter.value
    case "status":
      return filter.value
    case "after":
      return `after ${filter.value}`
    case "before":
      return `before ${filter.value}`
  }
}
