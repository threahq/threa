// Reuses JSON structure types since YAML maps to the JSON data model.
import yaml from "js-yaml"
import type { TextSection, JsonStructure } from "@threa/types"
import type { ParseResult, TextParser } from "./types"

const PREVIEW_LINES = 50
const MAX_KEYS_TO_SHOW = 20

export const yamlParser: TextParser = {
  parse(content: string, _filename: string): ParseResult {
    const lines = content.split("\n")
    const totalLines = lines.length

    let parsed: unknown
    try {
      parsed = yaml.load(content)
    } catch {
      // Invalid YAML - treat as plain text with yaml format
      return {
        format: "yaml",
        sections: [],
        structure: null,
        previewContent: lines.slice(0, PREVIEW_LINES).join("\n"),
        totalLines,
      }
    }

    const sections: TextSection[] = []
    let rootType: "object" | "array" | "primitive"
    let topLevelKeys: string[] | null = null
    let arrayLength: number | null = null
    let schemaDescription: string | null = null

    if (Array.isArray(parsed)) {
      rootType = "array"
      arrayLength = parsed.length
      schemaDescription = describeArraySchema(parsed)

      if (parsed.length > 10) {
        const chunkSize = Math.ceil(parsed.length / 10)
        for (let i = 0; i < parsed.length; i += chunkSize) {
          const end = Math.min(i + chunkSize, parsed.length)
          sections.push({
            type: "rows",
            path: `${i}-${end - 1}`,
            title: `Items ${i}-${end - 1}`,
            startLine: 0,
            endLine: totalLines,
          })
        }
      }
    } else if (typeof parsed === "object" && parsed !== null) {
      rootType = "object"
      topLevelKeys = Object.keys(parsed).slice(0, MAX_KEYS_TO_SHOW)
      schemaDescription = describeObjectSchema(parsed as Record<string, unknown>)

      for (const key of topLevelKeys) {
        const keyPattern = new RegExp(`^${escapeRegex(key)}:`, "m")
        const lineIndex = lines.findIndex((line) => keyPattern.test(line))

        sections.push({
          type: "key",
          path: key,
          title: key,
          startLine: lineIndex >= 0 ? lineIndex : 0,
          endLine: totalLines, // YAML keys don't have clear end boundaries
        })
      }
    } else {
      rootType = "primitive"
      schemaDescription = `Primitive value: ${typeof parsed}`
    }

    const structure: JsonStructure = {
      rootType,
      topLevelKeys,
      arrayLength,
      schemaDescription,
    }

    return {
      format: "yaml",
      sections,
      structure,
      previewContent: lines.slice(0, PREVIEW_LINES).join("\n"),
      totalLines,
    }
  },
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function describeArraySchema(arr: unknown[]): string {
  if (arr.length === 0) {
    return "Empty array"
  }

  const first = arr[0]
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    const keys = Object.keys(first).slice(0, 5)
    return `Array of ${arr.length} objects with keys: ${keys.join(", ")}${keys.length < Object.keys(first).length ? "..." : ""}`
  }

  if (Array.isArray(first)) {
    return `Array of ${arr.length} arrays`
  }

  return `Array of ${arr.length} ${typeof first} values`
}

function describeObjectSchema(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj)
  if (keys.length === 0) {
    return "Empty object"
  }

  const keyTypes = keys.slice(0, 5).map((key) => {
    const value = obj[key]
    const type = Array.isArray(value) ? "array" : typeof value
    return `${key}: ${type}`
  })

  return `Object with ${keys.length} keys: ${keyTypes.join(", ")}${keys.length > 5 ? "..." : ""}`
}
