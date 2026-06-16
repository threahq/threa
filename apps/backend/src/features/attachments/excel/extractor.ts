import * as XLSX from "xlsx"
import type { ExcelFormat } from "./detector"
import { EXCEL_SAMPLE_ROWS } from "./config"

export interface ExtractedSheet {
  name: string
  rows: number
  columns: number
  headers: string[]
  columnTypes: string[]
  /** All rows as strings (computed values) */
  data: string[][]
  /** First N rows for display */
  sampleRows: string[][]
}

export interface WorkbookMetadata {
  author: string | null
  createdAt: Date | null
  modifiedAt: Date | null
}

export interface ExtractedChart {
  sheetName: string
  type: string | null
  title: string | null
  description: string
}

export interface ExcelExtractionResult {
  sheets: ExtractedSheet[]
  metadata: WorkbookMetadata
  charts: ExtractedChart[]
}

export function extractExcel(buffer: Buffer, _format: ExcelFormat): ExcelExtractionResult {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    cellNF: true,
  })

  const sheets: ExtractedSheet[] = []

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName]
    if (!worksheet) continue

    const rawData: unknown[][] = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: false,
      defval: "",
    })

    if (rawData.length === 0) {
      sheets.push({
        name: sheetName,
        rows: 0,
        columns: 0,
        headers: [],
        columnTypes: [],
        data: [],
        sampleRows: [],
      })
      continue
    }

    const allRows = rawData.map((row) => row.map((cell) => String(cell ?? "")))
    const columnCount = allRows.reduce((max, row) => Math.max(max, row.length), 0)

    const headerRowIndex = detectHeaderRow(worksheet)

    let headers: string[]
    let dataRows: string[][]

    if (headerRowIndex !== null && headerRowIndex < allRows.length) {
      const detected = allRows[headerRowIndex]
      const fallback = generateColumnHeaders(columnCount)
      headers = fallback.map((letter, i) => (i < detected.length && detected[i] !== "" ? detected[i] : letter))
      dataRows = allRows.filter((_, i) => i !== headerRowIndex)
    } else {
      headers = generateColumnHeaders(columnCount)
      dataRows = allRows
    }

    const typeStartRow = headerRowIndex !== null ? headerRowIndex + 1 : 0
    const columnTypes = readColumnTypes(worksheet, typeStartRow, columnCount, 20)
    const sampleRows = dataRows.slice(0, EXCEL_SAMPLE_ROWS)

    sheets.push({
      name: sheetName,
      rows: dataRows.length,
      columns: columnCount,
      headers,
      columnTypes,
      data: dataRows,
      sampleRows,
    })
  }

  const props = workbook.Props ?? {}
  const metadata: WorkbookMetadata = {
    author: props.Author ?? null,
    createdAt: props.CreatedDate instanceof Date ? props.CreatedDate : null,
    modifiedAt: props.ModifiedDate instanceof Date ? props.ModifiedDate : null,
  }

  const charts = extractChartMetadata(workbook)

  return { sheets, metadata, charts }
}

/**
 * Generate Excel-style column headers: A, B, ..., Z, AA, AB, ...
 */
function generateColumnHeaders(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    let result = ""
    let n = i
    while (n >= 0) {
      result = String.fromCharCode(65 + (n % 26)) + result
      n = Math.floor(n / 26) - 1
    }
    return result
  })
}

/**
 * Detect a structurally defined header row via AutoFilter.
 * Returns the 0-indexed row number, or null if no header detected.
 */
function detectHeaderRow(worksheet: XLSX.WorkSheet): number | null {
  const autofilter = (worksheet as Record<string, unknown>)["!autofilter"] as { ref?: string } | undefined
  if (autofilter?.ref) {
    return XLSX.utils.decode_range(autofilter.ref).s.r
  }
  return null
}

/**
 * Read column types from cell metadata instead of guessing from strings.
 * Uses cell.t (type) and cell.z (number format) from the worksheet.
 */
function readColumnTypes(
  worksheet: XLSX.WorkSheet,
  startRow: number,
  columnCount: number,
  maxSample: number
): string[] {
  const types: string[] = new Array(columnCount).fill("empty")

  for (let col = 0; col < columnCount; col++) {
    const cellTypes: string[] = []

    for (let row = startRow; row < startRow + maxSample; row++) {
      const addr = XLSX.utils.encode_cell({ r: row, c: col })
      const cell = worksheet[addr] as XLSX.CellObject | undefined
      if (!cell?.t) continue

      const type = classifyCellType(cell)
      if (type) cellTypes.push(type)
    }

    types[col] = resolveColumnType(cellTypes)
  }

  return types
}

function classifyCellType(cell: XLSX.CellObject): string | null {
  switch (cell.t) {
    case "n":
      if (typeof cell.z === "string" && looksLikeDateFormat(cell.z)) return "date"
      return typeof cell.v === "number" && Number.isInteger(cell.v) ? "integer" : "number"
    case "s":
      return "text"
    case "b":
      return "boolean"
    case "d":
      return "date"
    default:
      return null
  }
}

function resolveColumnType(cellTypes: string[]): string {
  if (cellTypes.length === 0) return "empty"
  const unique = [...new Set(cellTypes)]
  if (unique.length === 1) return unique[0]
  if (unique.length === 2 && unique.includes("integer") && unique.includes("number")) return "number"
  return "text"
}

/**
 * Check if an Excel number format code represents a date.
 * Looks for 'y' (year) or 'd' (day) tokens, which are unambiguous date signals.
 */
function looksLikeDateFormat(fmt: string): boolean {
  const stripped = fmt.replace(/\[.*?\]/g, "").replace(/"[^"]*"/g, "")
  return /[yd]/i.test(stripped)
}

/**
 * Extract chart metadata from workbook.
 * SheetJS has limited chart support, so we extract what's available.
 */
function extractChartMetadata(workbook: XLSX.WorkBook): ExtractedChart[] {
  const charts: ExtractedChart[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue

    // SheetJS exposes chart sheets as separate entries marked with !type
    if ((sheet as Record<string, unknown>)["!type"] === "chart") {
      charts.push({
        sheetName,
        type: null,
        title: sheetName,
        description: `Chart sheet "${sheetName}"`,
      })
    }
  }

  return charts
}
