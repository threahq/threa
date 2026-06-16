import { EXCEL_MAGIC_BYTES } from "./config"

export type ExcelFormat = "xlsx" | "xls"

/**
 * Detect Excel document format from a file buffer using magic bytes.
 * Returns null if the buffer is not a recognized Excel document.
 */
export function detectExcelFormat(buffer: Buffer): ExcelFormat | null {
  if (buffer.length < 4) {
    return null
  }

  if (matchesMagicBytes(buffer, EXCEL_MAGIC_BYTES.xlsx)) {
    return "xlsx"
  }

  if (matchesMagicBytes(buffer, EXCEL_MAGIC_BYTES.xls)) {
    return "xls"
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
 * Detect Excel format, throwing if the buffer is not a recognized Excel document.
 */
export function validateExcelFormat(buffer: Buffer): ExcelFormat {
  const format = detectExcelFormat(buffer)
  if (!format) {
    throw new Error("Invalid Excel document: unrecognized file format")
  }
  return format
}
