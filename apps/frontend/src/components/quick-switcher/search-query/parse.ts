import type { QueryNode, FilterType, FilterNode, TextNode } from "./types"

const FILTER_TYPES: FilterType[] = ["from", "with", "in", "type", "status", "after", "before"]

/**
 * Parses a query string into an array of query nodes.
 *
 * Filter patterns recognized:
 * - from:@user → filter node
 * - with:@user → filter node
 * - in:#channel → filter node
 * - in:@user → filter node (DM)
 * - is:type → filter node (stream type)
 * - type:type → filter node (alias for is:)
 * - status:active → filter node (archive status)
 * - after:date → filter node
 * - before:date → filter node
 *
 * Non-filter patterns:
 * - @user (standalone) → text node (search term, not filter)
 * - #channel (standalone) → text node (search term, not filter)
 * - "quoted text" → text node with isQuoted=true
 * - plain text → text node
 *
 * Special handling:
 * - Leading "?" is stripped (search mode prefix)
 * - Multiple consecutive spaces are collapsed
 */
export function parse(input: string): QueryNode[] {
  let normalized = input.trim()
  if (normalized.startsWith("?")) {
    normalized = normalized.slice(1).trimStart()
  }

  if (!normalized) {
    return []
  }

  const nodes: QueryNode[] = []
  const tokens = tokenize(normalized)

  for (const token of tokens) {
    const node = parseToken(token)
    if (node) {
      nodes.push(node)
    }
  }

  return nodes
}

/**
 * Tokenizes a query string into individual tokens.
 * Handles quoted strings as single tokens.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (char === '"') {
      if (inQuotes) {
        tokens.push(`"${current}"`)
        current = ""
        inQuotes = false
      } else {
        // Start of quoted string - save any accumulated non-quoted content first
        if (current.trim()) {
          tokens.push(...current.trim().split(/\s+/))
        }
        current = ""
        inQuotes = true
      }
    } else if (char === " " && !inQuotes) {
      if (current.trim()) {
        tokens.push(current.trim())
      }
      current = ""
    } else {
      current += char
    }
  }

  if (current.trim()) {
    if (inQuotes) {
      // Unclosed quote - treat as regular tokens
      tokens.push(...current.trim().split(/\s+/))
    } else {
      tokens.push(current.trim())
    }
  }

  return tokens
}

/**
 * Parses a single token into a query node.
 */
function parseToken(token: string): QueryNode | null {
  if (!token) {
    return null
  }

  if (token.startsWith('"') && token.endsWith('"')) {
    const text = token.slice(1, -1)
    return { type: "text", text, isQuoted: true } as TextNode
  }

  for (const filterType of FILTER_TYPES) {
    const prefix = `${filterType}:`
    if (token.startsWith(prefix)) {
      const value = token.slice(prefix.length)
      if (value) {
        return { type: "filter", filterType, value } as FilterNode
      }
    }
  }

  // Handle is: as primary for type filter
  if (token.startsWith("is:")) {
    const value = token.slice(3)
    if (value) {
      return { type: "filter", filterType: "type", value } as FilterNode
    }
  }

  // Everything else is plain text (including standalone @mentions and #channels)
  return { type: "text", text: token } as TextNode
}
