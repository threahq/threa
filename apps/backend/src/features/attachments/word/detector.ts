import { WORD_MAGIC_BYTES } from "./config"

export type WordFormat = "docx" | "doc"

/**
 * Detect Word document format from file buffer using magic bytes.
 *
 * @param buffer - First 4+ bytes of the file
 * @returns Detected format or null if not a recognized Word document
 */
export function detectWordFormat(buffer: Buffer): WordFormat | null {
  if (buffer.length < 4) {
    return null
  }

  if (matchesMagicBytes(buffer, WORD_MAGIC_BYTES.docx)) {
    return "docx"
  }

  if (matchesMagicBytes(buffer, WORD_MAGIC_BYTES.doc)) {
    return "doc"
  }

  return null
}

function matchesMagicBytes(buffer: Buffer, magicBytes: readonly number[]): boolean {
  for (let i = 0; i < magicBytes.length; i++) {
    if (buffer[i] !== magicBytes[i]) {
      return false
    }
  }
  return true
}

/**
 * Validate that a buffer is a valid Word document.
 *
 * @param buffer - File buffer to validate
 * @returns Validated format or throws if invalid
 */
export function validateWordFormat(buffer: Buffer): WordFormat {
  const format = detectWordFormat(buffer)
  if (!format) {
    throw new Error("Invalid Word document: unrecognized file format")
  }
  return format
}
