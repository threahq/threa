import type { TextFormat } from "@threa/types"
import { BINARY_DETECTION, EXTENSION_FORMAT_MAP, getFileExtension } from "./config"

/**
 * Check if a buffer contains binary content.
 *
 * Detects binary files by:
 * 1. Checking for null bytes (common in binary files)
 * 2. Looking for invalid UTF-8 sequences
 *
 * @param buffer First few KB of the file
 * @returns true if file appears to be binary
 */
export function isBinaryFile(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_DETECTION.checkSize)

  if (checkLength === 0) {
    return false
  }

  let nullByteCount = 0

  for (let i = 0; i < checkLength; i++) {
    const byte = buffer[i]
    if (byte === 0) {
      nullByteCount++
    }
  }

  if (nullByteCount / checkLength > BINARY_DETECTION.nullByteThreshold) {
    return true
  }

  try {
    const text = buffer.slice(0, checkLength).toString("utf-8")
    // Invalid UTF-8 sequences decode to U+FFFD; tolerate a few legitimate ones.
    const replacementCount = (text.match(/\uFFFD/g) || []).length
    if (replacementCount / text.length > 0.01) {
      return true
    }
  } catch {
    return true
  }

  return false
}

/**
 * Detect the encoding of a buffer and normalize to UTF-8.
 *
 * Handles:
 * - UTF-8 (with or without BOM)
 * - UTF-16 LE/BE (with BOM)
 * - ASCII (subset of UTF-8)
 *
 * @param buffer File content
 * @returns Object with normalized text and detected encoding
 */
export function normalizeEncoding(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.slice(3).toString("utf-8"), encoding: "utf-8-bom" }
  }

  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { text: buffer.slice(2).toString("utf16le"), encoding: "utf-16le" }
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      // Node has no utf16be decoder, so swap bytes into utf16le.
      const swapped = Buffer.alloc(buffer.length - 2)
      for (let i = 2; i < buffer.length - 1; i += 2) {
        swapped[i - 2] = buffer[i + 1]
        swapped[i - 1] = buffer[i]
      }
      return { text: swapped.toString("utf16le"), encoding: "utf-16be" }
    }
  }

  return { text: buffer.toString("utf-8"), encoding: "utf-8" }
}

/**
 * Infer the text format from filename and content.
 *
 * Priority:
 * 1. Extension-based detection (reliable)
 * 2. Content heuristics (fallback)
 * 3. Default to 'plain'
 *
 * @param filename File name
 * @param content File content (first few lines)
 * @returns Detected format
 */
export function inferFormat(filename: string, content: string): TextFormat {
  const ext = getFileExtension(filename.toLowerCase())

  if (ext && EXTENSION_FORMAT_MAP[ext]) {
    return EXTENSION_FORMAT_MAP[ext]
  }

  const trimmedContent = content.trim()

  if (
    (trimmedContent.startsWith("{") && trimmedContent.includes(":")) ||
    (trimmedContent.startsWith("[") && (trimmedContent.includes("{") || trimmedContent.includes('"')))
  ) {
    try {
      JSON.parse(trimmedContent.slice(0, 1000))
      return "json"
    } catch {
      // Not valid JSON, continue checking
    }
  }

  if (trimmedContent.startsWith("---") || /^[a-zA-Z_][a-zA-Z0-9_]*:\s/m.test(trimmedContent)) {
    const yamlLikeLines = trimmedContent.split("\n").filter((line) => /^[a-zA-Z_][a-zA-Z0-9_]*:\s/.test(line))
    if (yamlLikeLines.length >= 2) {
      return "yaml"
    }
  }

  // Comma-separated with consistent column count across the first lines.
  const lines = trimmedContent.split("\n").slice(0, 5)
  if (lines.length >= 2) {
    const columnCounts = lines.map((line) => line.split(",").length)
    const allSame = columnCounts.every((count) => count === columnCounts[0] && count >= 2)
    if (allSame) {
      return "csv"
    }
  }

  if (
    /^#{1,6}\s/.test(trimmedContent) || // Headings
    /^\*\*.*\*\*/.test(trimmedContent) || // Bold
    /^\[.*\]\(.*\)/.test(trimmedContent) || // Links
    /^```/.test(trimmedContent) // Code blocks
  ) {
    return "markdown"
  }

  return "plain"
}
