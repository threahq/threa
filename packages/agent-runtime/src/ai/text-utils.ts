/**
 * AI text processing utilities.
 */

/**
 * Convert snake_case to camelCase.
 */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

export interface SemanticFieldMapping {
  field: string
  transform?: (v: unknown) => unknown
}

export interface JsonRepairOptions {
  fieldMappings?: Record<string, SemanticFieldMapping>
  addDefaults?: (obj: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Recursively convert all snake_case keys in an object to camelCase,
 * and apply semantic field mappings.
 */
function normalizeObject(obj: unknown, fieldMappings?: Record<string, SemanticFieldMapping>): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => normalizeObject(item, fieldMappings))
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      // Check for semantic mapping first
      const mapping = fieldMappings?.[key]
      if (mapping) {
        const transformedValue = mapping.transform ? mapping.transform(value) : value
        result[mapping.field] = normalizeObject(transformedValue, fieldMappings)
      } else {
        // Convert snake_case to camelCase
        result[snakeToCamel(key)] = normalizeObject(value, fieldMappings)
      }
    }
    return result
  }
  return obj
}

/**
 * Extract the first valid JSON object from text that may have garbage prefixes.
 *
 * Some models output garbage before JSON like:
 * - "that.{...}"
 * - "{{...}}"  (double braces)
 * - "reason.{...}"
 * - '": true}.{...}' (fragments from previous output)
 */
function extractJsonObject(text: string): string {
  // Find the first '{' that might start valid JSON
  const firstBrace = text.indexOf("{")
  if (firstBrace === -1) return text

  // Try parsing from each '{' until we find valid JSON
  let pos = firstBrace
  while (pos < text.length) {
    const candidate = text.slice(pos)

    // Skip if we hit a double brace - try the inner one
    if (candidate.startsWith("{{") || candidate.startsWith("{ {")) {
      pos = text.indexOf("{", pos + 1)
      if (pos === -1) break
      continue
    }

    // Try to find matching closing brace by counting
    let depth = 0
    let inString = false
    let escape = false
    let end = -1

    for (let i = 0; i < candidate.length; i++) {
      const char = candidate[i]

      if (escape) {
        escape = false
        continue
      }

      if (char === "\\") {
        escape = true
        continue
      }

      if (char === '"') {
        inString = !inString
        continue
      }

      if (inString) continue

      if (char === "{") depth++
      if (char === "}") {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }

    if (end > 0) {
      const extracted = candidate.slice(0, end)
      try {
        JSON.parse(extracted)
        return extracted
      } catch {
        // Not valid JSON, try next brace
      }
    }

    // Find next '{' to try
    const nextBrace = text.indexOf("{", pos + 1)
    if (nextBrace === -1) break
    pos = nextBrace
  }

  // Couldn't extract valid JSON, return original
  return text
}

/**
 * Create a JSON repair function with optional semantic field mappings and defaults.
 */
export function createJsonRepair(options: JsonRepairOptions = {}) {
  const { fieldMappings, addDefaults } = options

  return async ({ text }: { text: string }): Promise<string> => {
    // Strip markdown fences
    let cleaned = text
      .replace(/^\s*```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim()

    // Extract JSON object from garbage prefixes
    cleaned = extractJsonObject(cleaned)

    // Try to parse and normalize field names
    try {
      const parsed = JSON.parse(cleaned)
      const normalized = normalizeObject(parsed, fieldMappings) as Record<string, unknown>
      const withDefaults = addDefaults ? addDefaults(normalized) : normalized
      return JSON.stringify(withDefaults)
    } catch {
      // If parsing fails, return the cleaned text as-is
      return cleaned
    }
  }
}

/**
 * Strip markdown code fences and normalize JSON field names.
 *
 * Handles common LLM output issues:
 * - Garbage prefixes before JSON (e.g., "that.{...}")
 * - Double braces (e.g., "{{...}}")
 * - Markdown code fences (```json ... ```)
 * - snake_case field names instead of camelCase
 */
export async function stripMarkdownFences({ text }: { text: string }): Promise<string> {
  return createJsonRepair()({ text })
}
