import type { FetchLike } from "./http"
import type { RailwayLogLine } from "./railway"

const HOST = "https://eu.posthog.com"

// OpenTelemetry SeverityNumber ranges
export const OTEL_SEVERITY = { warn: 13, error: 17 } as const

export interface ExceptionGroup {
  issueId: string | null
  lib: string
  type: string
  value: string
  since: number
  prior: number
  lastAt: string
}

/** HogQL reads bare datetimes in the project timezone (Europe/Stockholm), so every bound pins UTC. */
export function hogqlUtc(iso: string): string {
  return `toDateTime('${new Date(iso).toISOString().slice(0, 19).replace("T", " ")}', 'UTC')`
}

function firstOfJsonArray(raw: unknown): string {
  if (typeof raw !== "string") return ""
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? String(parsed[0]) : ""
  } catch {
    return ""
  }
}

interface ExceptionRow {
  issue_id: unknown
  lib: unknown
  types: unknown
  vals: unknown
  since: unknown
  prior: unknown
  last: unknown
}

export function toExceptionGroup(row: ExceptionRow): ExceptionGroup {
  return {
    issueId: typeof row.issue_id === "string" && row.issue_id ? row.issue_id : null,
    lib: String(row.lib ?? ""),
    type: firstOfJsonArray(row.types),
    value: firstOfJsonArray(row.vals),
    since: Number(row.since),
    prior: Number(row.prior),
    lastAt: new Date(String(row.last)).toISOString(),
  }
}

export class PostHogClient {
  constructor(
    private readonly apiKey: string,
    private readonly projectId: string,
    private readonly fetchImpl: FetchLike
  ) {}

  async hogql(query: string): Promise<{ columns: string[]; results: unknown[][] }> {
    const res = await this.fetchImpl(`${HOST}/api/projects/${this.projectId}/query/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`posthog ${res.status}: ${text.slice(0, 300)}`)
    let json: { columns?: string[]; results?: unknown[][]; error?: unknown }
    try {
      json = JSON.parse(text) as typeof json
    } catch {
      throw new Error(`posthog ${res.status}: non-JSON body ${text.slice(0, 200)}`)
    }
    if (json.error) throw new Error(`posthog ${res.status}: ${String(json.error)}`)
    if (!Array.isArray(json.results)) throw new Error(`posthog ${res.status}: no results in ${text.slice(0, 200)}`)
    return { columns: json.columns ?? [], results: json.results }
  }

  async rows<T>(query: string): Promise<T[]> {
    const { columns, results } = await this.hogql(query)
    return results.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])) as T)
  }

  async logs(params: {
    minSeverity: number
    maxSeverity?: number
    after: string
    before?: string
    limit: number
  }): Promise<RailwayLogLine[]> {
    const rows = await this.rows<{ timestamp: unknown; service_name: unknown; severity_text: unknown; body: unknown }>(
      `select timestamp as timestamp, service_name as service_name, severity_text as severity_text, body as body
         from logs
        where timestamp >= ${hogqlUtc(params.after)}
          ${params.before ? `and timestamp < ${hogqlUtc(params.before)}` : ""}
          and severity_number >= ${params.minSeverity}
          ${params.maxSeverity === undefined ? "" : `and severity_number < ${params.maxSeverity}`}
        order by timestamp desc
        limit ${params.limit}`
    )
    return rows.reverse().map((r) => ({
      timestamp: new Date(String(r.timestamp)).toISOString(),
      severity: String(r.severity_text),
      message: String(r.body ?? ""),
      service: typeof r.service_name === "string" ? r.service_name.replace(/^threa-/, "") : null,
      attributes: {},
    }))
  }

  async logsRetainedFrom(): Promise<string | null> {
    const [row] = await this.rows<{ first: unknown }>(`select min(timestamp) as first from logs`)
    if (!row?.first) return null
    const date = new Date(String(row.first))
    return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? null : date.toISOString()
  }

  async exceptionGroups(params: { priorStart: string; since: string; limit: number }): Promise<ExceptionGroup[]> {
    const since = hogqlUtc(params.since)
    const rows = await this.rows<ExceptionRow>(
      `select properties.$exception_issue_id as issue_id,
              properties.$lib as lib,
              argMax(properties.$exception_types, timestamp) as types,
              argMax(properties.$exception_values, timestamp) as vals,
              countIf(timestamp >= ${since}) as since,
              countIf(timestamp < ${since}) as prior,
              max(timestamp) as last
         from events
        where event = '$exception' and timestamp >= ${hogqlUtc(params.priorStart)}
        group by issue_id, lib
        order by since desc
        limit ${params.limit}`
    )
    return rows.map(toExceptionGroup)
  }
}
