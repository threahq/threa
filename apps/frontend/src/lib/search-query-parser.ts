/**
 * Parse and serialize search queries with filter support.
 *
 * Supports filters: from:@user, with:@user, in:#channel, in:@user (DM), is:streamType, type:streamType (alias), status:archiveStatus, after:date, before:date
 *
 * `/steer <prose>` marks everything after it as a plain-language refinement of
 * the result list; it is carried separately and never searched as text.
 */
import { MAX_SEARCH_STEERS, MAX_SEARCH_STEER_CHARS } from "@threahq/types"

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
  /** Prose after `/steer`, `""` while only the marker is typed, null without one. */
  steer: string | null
}

const STEER_MARKER = /(?:^|\s)\/steer(?=\s|$)/

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
  const { query: searchable, steer } = splitSteer(query)
  return { ...parseSearchable(searchable), steer }
}

function splitSteer(query: string): { query: string; steer: string | null } {
  const match = STEER_MARKER.exec(query)
  if (!match) return { query, steer: null }
  return {
    query: query.slice(0, match.index),
    steer: query.slice(match.index + match[0].length).trim(),
  }
}

function parseSearchable(query: string): Omit<ParsedQuery, "steer"> {
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
export function serializeSearchQuery(filters: ParsedFilter[], text: string, steer: string | null = null): string {
  const filterParts = filters.map((f) => f.raw)
  const parts = [...filterParts]

  if (text.trim()) {
    parts.push(text.trim())
  }
  if (steer !== null) {
    parts.push(steer ? `/steer ${steer}` : "/steer")
  }

  return parts.join(" ")
}

/**
 * Remove a filter from the query string.
 */
export function removeFilterFromQuery(query: string, filterIndex: number): string {
  const { filters, text, steer } = parseSearchQuery(query)
  const newFilters = filters.filter((_, i) => i !== filterIndex)
  return serializeSearchQuery(newFilters, text, steer)
}

/** The query without its `/steer …` tail, for after the steer has been committed as a chip. */
export function removeSteerFromQuery(query: string): string {
  return splitSteer(query).query.trim()
}

/**
 * The steer trail the backend accepts: trimmed, non-empty, within the length
 * cap, and only the newest `MAX_SEARCH_STEERS`. Applied when a steer is
 * committed and when a trail is restored from a URL.
 */
export function boundSteers(steers: string[]): string[] {
  return steers
    .map((steer) => steer.trim())
    .filter((steer) => steer.length > 0 && steer.length <= MAX_SEARCH_STEER_CHARS)
    .slice(-MAX_SEARCH_STEERS)
}

/**
 * Add a filter to the query string.
 */
export function addFilterToQuery(query: string, type: FilterType, value: string): string {
  const { filters, text, steer } = parseSearchQuery(query)

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
  return serializeSearchQuery([...filters, newFilter], text, steer)
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
