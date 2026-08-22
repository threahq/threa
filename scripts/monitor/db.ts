import type { FetchLike } from "./http"

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  durationMs: number
}

/** Read-only prod Postgres through apps/db-read-proxy (read-only tx, 5s statement timeout, row cap). */
export class ReadProxyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: FetchLike
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Proxy-Secret": this.secret },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`db-read-proxy ${res.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as QueryResult
  }

  /** Rows as objects keyed by column name. */
  async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.query(sql, params)
    return result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]])) as T)
  }
}
