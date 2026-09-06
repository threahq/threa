import type { PdfPageClassification } from "@threahq/types"
import { PdfPageClassifications } from "@threahq/types"
import { PDF_TEXT_THRESHOLDS } from "./config"

/** Text item with position, mirroring PDF.js TextContent items. */
export interface TextItemWithPosition {
  str: string
  /** X position (from transform matrix). */
  x: number
  /** Y position (from transform matrix). */
  y: number
  width: number
  height: number
}

export interface ClassificationInput {
  /** Raw text extracted from the page */
  rawText: string | null
  /** Number of embedded images in the page */
  imageCount: number
  /** Whether tables were detected (auto-detected if not provided) */
  hasTables?: boolean
  /** Whether multi-column layout was detected (auto-detected if not provided) */
  isMultiColumn?: boolean
  /** Text items with position info for layout detection */
  textItems?: TextItemWithPosition[]
}

export interface ClassificationResult {
  classification: PdfPageClassification
  confidence: number
}

/**
 * Classify a PDF page based on its content characteristics.
 *
 * Classification determines processing strategy:
 * - text_rich: Use raw text extraction (fastest)
 * - scanned: Apply OCR via Tesseract
 * - complex_layout: Use Gemini for intelligent extraction
 * - mixed: Combine text extraction + image captioning
 * - empty: Skip processing
 */
export function classifyPage(input: ClassificationInput): ClassificationResult {
  const { rawText, imageCount, textItems } = input
  const textLength = rawText?.length ?? 0

  // Auto-detect layout characteristics if not explicitly provided
  const hasTables = input.hasTables ?? detectTables(rawText, textItems)
  const isMultiColumn = input.isMultiColumn ?? detectMultiColumn(textItems)

  // Empty pages
  if (textLength < 10 && imageCount === 0) {
    return { classification: PdfPageClassifications.EMPTY, confidence: 0.95 }
  }

  // Scanned document (image-only or minimal text)
  if (textLength < PDF_TEXT_THRESHOLDS.scanned && imageCount > 0) {
    return { classification: PdfPageClassifications.SCANNED, confidence: 0.85 }
  }

  // Complex layout (tables, multi-column, or significant images with text)
  if (hasTables || isMultiColumn) {
    return { classification: PdfPageClassifications.COMPLEX_LAYOUT, confidence: 0.8 }
  }

  // Mixed content (text + embedded images)
  if (textLength >= PDF_TEXT_THRESHOLDS.textRich && imageCount > 0) {
    return { classification: PdfPageClassifications.MIXED, confidence: 0.75 }
  }

  // Text-rich (straightforward text extraction)
  if (textLength >= PDF_TEXT_THRESHOLDS.textRich) {
    return { classification: PdfPageClassifications.TEXT_RICH, confidence: 0.9 }
  }

  // Default to scanned if we have images but little text
  if (imageCount > 0) {
    return { classification: PdfPageClassifications.SCANNED, confidence: 0.6 }
  }

  // Fallback to empty if very little content
  return { classification: PdfPageClassifications.EMPTY, confidence: 0.5 }
}

/**
 * Detect tables in page content using text patterns and layout analysis.
 *
 * Heuristics:
 * 1. Look for pipe characters (|) which indicate ASCII/Markdown tables
 * 2. Look for tab-separated content patterns
 * 3. Analyze text positions for grid-like alignment
 */
function detectTables(rawText: string | null, textItems?: TextItemWithPosition[]): boolean {
  if (!rawText) return false

  // Pattern 1: Pipe characters (common in ASCII tables)
  // Look for lines with multiple pipe characters
  const lines = rawText.split("\n")
  const pipeLines = lines.filter((line) => {
    const pipeCount = (line.match(/\|/g) || []).length
    return pipeCount >= 2
  })
  if (pipeLines.length >= 2) {
    return true
  }

  // Pattern 2: Tab-separated values (common in copied spreadsheets)
  const tabLines = lines.filter((line) => {
    const tabCount = (line.match(/\t/g) || []).length
    return tabCount >= 2
  })
  if (tabLines.length >= 2) {
    return true
  }

  // Pattern 3: Grid-like alignment from text positions
  if (textItems && textItems.length >= 10) {
    if (hasGridPattern(textItems)) {
      return true
    }
  }

  return false
}

/**
 * Detect multi-column layout by analyzing text x-positions.
 *
 * Multi-column documents have text clustered at distinct x-positions
 * with gaps between them.
 */
function detectMultiColumn(textItems?: TextItemWithPosition[]): boolean {
  if (!textItems || textItems.length < 20) {
    return false
  }

  // Get unique x-positions (rounded to reduce noise)
  const xPositions = textItems.map((item) => Math.round(item.x / 10) * 10)

  // Count occurrences of each x-position
  const xCounts = new Map<number, number>()
  for (const x of xPositions) {
    xCounts.set(x, (xCounts.get(x) || 0) + 1)
  }

  // Find dominant x-positions (columns) with at least 5 items
  const dominantXPositions = Array.from(xCounts.entries())
    .filter(([_, count]) => count >= 5)
    .map(([x, _]) => x)
    .sort((a, b) => a - b)

  if (dominantXPositions.length < 2) {
    return false
  }

  // Check if there's a significant gap between columns
  // Typical page width is ~600-800 points, column gap should be at least 50
  const MIN_COLUMN_GAP = 50
  for (let i = 1; i < dominantXPositions.length; i++) {
    const gap = dominantXPositions[i] - dominantXPositions[i - 1]
    if (gap >= MIN_COLUMN_GAP) {
      return true
    }
  }

  return false
}

/**
 * Detect grid-like patterns in text positions (indicating tables).
 *
 * Tables have text items aligned in rows and columns with regular spacing.
 */
function hasGridPattern(textItems: TextItemWithPosition[]): boolean {
  // Round positions to reduce noise
  const roundedItems = textItems.map((item) => ({
    x: Math.round(item.x / 5) * 5,
    y: Math.round(item.y / 5) * 5,
  }))

  // Group by y-position (rows)
  const rows = new Map<number, number[]>()
  for (const item of roundedItems) {
    if (!rows.has(item.y)) {
      rows.set(item.y, [])
    }
    rows.get(item.y)!.push(item.x)
  }

  // Count rows with multiple aligned x-positions
  let alignedRows = 0
  const rowsArray = Array.from(rows.values())

  for (const xPositions of rowsArray) {
    // A row with 3+ items at distinct x-positions suggests table structure
    const uniqueX = new Set(xPositions)
    if (uniqueX.size >= 3) {
      alignedRows++
    }
  }

  // If multiple rows have aligned columns, likely a table
  return alignedRows >= 3
}

/**
 * Batch classify multiple pages.
 */
export function classifyPages(inputs: ClassificationInput[]): ClassificationResult[] {
  return inputs.map(classifyPage)
}
