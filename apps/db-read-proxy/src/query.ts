import type { Pool } from "pg"
import { logger } from "@threa/backend-common"

export interface QueryRequest {
  sql: string
  params?: unknown[]
}

export interface QueryResponse {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  durationMs: number
}

export class QueryValidationError extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = "QueryValidationError"
  }
}

export class QueryExecutionError extends Error {
  readonly status: number
  readonly pgCode: string | undefined
  constructor(message: string, status: number, pgCode?: string) {
    super(message)
    this.name = "QueryExecutionError"
    this.status = status
    this.pgCode = pgCode
  }
}

const ALLOWED_LEADING_KEYWORDS = new Set(["SELECT", "WITH", "EXPLAIN", "SHOW", "VALUES", "TABLE"])
const WRAPPABLE_KEYWORDS = new Set(["SELECT", "WITH", "VALUES", "TABLE"])

/**
 * Strip SQL comments and string/identifier literals so a downstream keyword /
 * semicolon scan sees only "real" tokens. Handles:
 *   - `--` line comments
 *   - `/* ... *\/` block comments (non-nesting, matches Postgres practice for our checks)
 *   - `'...'` single-quoted strings with `''` escapes
 *   - `"..."` quoted identifiers with `""` escapes
 *   - `$tag$...$tag$` dollar-quoted strings (any tag)
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = ""
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    if (ch === "'") {
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2
          continue
        }
        if (sql[i] === "'") {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '"') {
      i++
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2
          continue
        }
        if (sql[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const end = sql.indexOf(tag, i + tag.length)
        i = end === -1 ? sql.length : end + tag.length
        continue
      }
    }

    out += ch
    i++
  }
  return out
}

/** Extract the first SQL keyword (case-insensitive). Returns "" if none. */
function firstKeyword(sql: string): string {
  const match = /^\s*([A-Za-z]+)/.exec(sql)
  return match ? match[1].toUpperCase() : ""
}

/**
 * Validate a user-supplied SQL string:
 *   - non-empty after trimming
 *   - first non-comment keyword is in `ALLOWED_LEADING_KEYWORDS`
 *   - no semicolons inside the statement (a single trailing semicolon is OK)
 *
 * Returns the cleaned SQL (trailing semicolon stripped) and the first
 * keyword. Throws `QueryValidationError` on any violation.
 */
export function validateSql(rawSql: string): { sql: string; keyword: string } {
  const trimmed = rawSql.trim()
  if (trimmed.length === 0) {
    throw new QueryValidationError("sql must be a non-empty string")
  }
  if (trimmed.length > 50_000) {
    throw new QueryValidationError("sql exceeds 50000 character limit")
  }

  const sanitized = stripLiteralsAndComments(trimmed)
  const keyword = firstKeyword(sanitized)
  if (!ALLOWED_LEADING_KEYWORDS.has(keyword)) {
    throw new QueryValidationError(
      `only ${[...ALLOWED_LEADING_KEYWORDS].join("/")} statements are allowed (got "${keyword || "<empty>"}")`
    )
  }

  const semiIndex = sanitized.indexOf(";")
  if (semiIndex !== -1) {
    const after = sanitized.slice(semiIndex + 1).trim()
    if (after.length > 0) {
      throw new QueryValidationError("multi-statement SQL is not allowed")
    }
  }

  const sql = trimmed.replace(/;\s*$/, "")
  return { sql, keyword }
}

/**
 * Wrap SELECT/WITH/VALUES/TABLE queries with an outer LIMIT so the result
 * set is hard-capped regardless of what the user wrote. EXPLAIN and SHOW
 * are run as-is — they don't return arbitrary-size row sets.
 */
function wrapWithRowCap(sql: string, keyword: string, maxRows: number): string {
  if (!WRAPPABLE_KEYWORDS.has(keyword)) return sql
  return `SELECT * FROM (${sql}) AS __db_read_proxy_wrapped LIMIT ${maxRows + 1}`
}

export interface ExecuteOptions {
  pool: Pool
  statementTimeoutMs: number
  maxRows: number
}

export async function executeReadOnly(req: QueryRequest, opts: ExecuteOptions): Promise<QueryResponse> {
  const { sql, keyword } = validateSql(req.sql)
  const wrapped = wrapWithRowCap(sql, keyword, opts.maxRows)
  const params = req.params ?? []

  const start = performance.now()
  const client = await opts.pool.connect()
  try {
    await client.query("BEGIN READ ONLY")
    await client.query(`SET LOCAL statement_timeout = ${opts.statementTimeoutMs}`)
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${opts.statementTimeoutMs}`)
    const result = await client.query<unknown[]>({ text: wrapped, values: params, rowMode: "array" })
    await client.query("ROLLBACK")

    const allRows = result.rows
    const truncated = WRAPPABLE_KEYWORDS.has(keyword) && allRows.length > opts.maxRows
    const rows = truncated ? allRows.slice(0, opts.maxRows) : allRows

    return {
      columns: result.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK")
    } catch {
      /* the transaction may already be aborted */
    }
    const pgErr = err as { code?: string; message?: string }
    const pgCode = typeof pgErr.code === "string" ? pgErr.code : undefined
    const status = pgCode === "57014" ? 504 : 400
    const message = pgErr.message ?? "query failed"
    logger.warn({ pgCode, sql, durationMs: Math.round(performance.now() - start) }, "db-read-proxy query failed")
    throw new QueryExecutionError(message, status, pgCode)
  } finally {
    client.release()
  }
}
