import { DECOMMISSIONED_LISTENERS } from "./config"
import type { Finding, Level } from "./types"
import type { Snapshot } from "./snapshot"
import type { RevisionReport } from "./probes/revision"
import type { LogReport } from "./probes/logs"

const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗", pending: "…", skipped: "-" }

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

function fmtAge(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h${minutes % 60}m ago` : `${Math.floor(hours / 24)}d ago`
}

export function renderRevision(revision: RevisionReport, now: Date): string[] {
  const width = Math.max(...revision.planes.map((plane) => plane.plane.length))
  const lines = [`revision  expected ${revision.expected.slice(0, 8)}`]
  for (const plane of revision.planes) {
    const age = plane.deployedAt ? ` (${fmtAge(plane.deployedAt, now)})` : ""
    lines.push(
      `  ${MARK[plane.level]} ${pad(plane.plane, width)}  ${pad(plane.live?.slice(0, 8) ?? "?", 8)}  ${plane.detail}${age}`
    )
  }
  return lines
}

export function renderLogs(logs: LogReport, top: number): string[] {
  const lines = [`logs      ${logs.window.label}; prior window equal length`]
  for (const service of logs.services) {
    lines.push(
      `  ${pad(service.service, 14)} error ${service.errorSince} (prior ${service.errorPrior})  warn ${service.warnSince} (prior ${service.warnPrior})${service.noiseSince ? `  noise ${service.noiseSince}` : ""}`
    )
  }
  const shown = logs.templates.filter((template) => !template.noise).slice(0, top)
  if (shown.length) lines.push("  top templates:")
  for (const template of shown) {
    lines.push(
      `    ×${pad(String(template.count), 4)} [${template.services.join(",")}] ${template.sample.slice(0, 150).replace(/\n/g, " ")}`
    )
  }
  if (logs.truncated) lines.push("  (fetch capped; counts are lower bounds)")
  return lines
}

export function renderSnapshot(snapshot: Snapshot, opts: { top?: number } = {}): string {
  const now = new Date(snapshot.at)
  const out: string[] = []
  out.push(
    `${MARK[snapshot.level]} ${snapshot.level.toUpperCase()}  ${snapshot.at.slice(0, 19)}Z  ${snapshot.window.label}`
  )
  if (snapshot.revision) out.push(...renderRevision(snapshot.revision, now))
  if (snapshot.liveness) {
    out.push("liveness")
    const width = Math.max(...snapshot.liveness.checks.map((check) => check.name.length))
    for (const check of snapshot.liveness.checks)
      out.push(`  ${MARK[check.level]} ${pad(check.name, width)}  ${check.detail}`)
  }
  if (snapshot.pipelines) {
    const pipelines = snapshot.pipelines
    const behind = pipelines.outbox.listeners.filter((listener) => listener.lag > 0)
    out.push(
      `pipelines outbox head ${pipelines.outbox.head}, ${pipelines.outbox.listeners.length} listeners, ${
        behind.length
          ? behind
              .map((listener) => {
                const retired = DECOMMISSIONED_LISTENERS.find((entry) => entry.id === listener.listener_id)
                return `${listener.listener_id} lag ${listener.lag}${retired ? ` (decommissioned: ${retired.why})` : ""}`
              })
              .join(", ")
          : "all caught up"
      }; dead letters ${pipelines.deadLetters.since} (prior ${pipelines.deadLetters.prior})`
    )
    const busy = pipelines.queues.filter((queue) => queue.running || queue.ready || queue.dlq_since || queue.done_since)
    for (const queue of busy) {
      out.push(
        `  ${pad(queue.queue_name, 30)} running ${queue.running}  ready ${queue.ready}${queue.oldest_ready_sec ? ` (oldest ${queue.oldest_ready_sec}s)` : ""}  done ${queue.done_since} (prior ${queue.done_prior})${queue.dlq_since || queue.dlq_prior ? `  dlq ${queue.dlq_since} (prior ${queue.dlq_prior})` : ""}`
      )
    }
    const idle = pipelines.queues.length - busy.length
    if (idle) out.push(`  ${idle} idle queues`)
    for (const counter of pipelines.counters)
      if (counter.since || counter.prior)
        out.push(`  ${pad(counter.metric, 30)} ${counter.since} (prior ${counter.prior})`)
  }
  if (snapshot.logs) out.push(...renderLogs(snapshot.logs, opts.top ?? 5))
  if (snapshot.resources) {
    out.push("resources")
    for (const row of snapshot.resources.rows) {
      const cpu = row.cpuNow === null ? "?" : `${(row.cpuNow * 1000).toFixed(0)}m`
      const mem = row.memNowGb === null ? "?" : `${(row.memNowGb * 1024).toFixed(0)}MB`
      const memPeak =
        row.memMaxSinceGb !== null && row.memMaxPriorGb !== null
          ? ` (peak ${(row.memMaxSinceGb * 1024).toFixed(0)}MB vs prior ${(row.memMaxPriorGb * 1024).toFixed(0)}MB)`
          : ""
      out.push(`  ${pad(row.service, 14)} cpu ${cpu}  mem ${mem}${memPeak}`)
    }
  }
  if (snapshot.findings.length) {
    out.push("findings")
    for (const finding of snapshot.findings) out.push(`  ${MARK[finding.level]} ${finding.message}`)
  } else {
    out.push("findings  none")
  }
  return out.join("\n")
}

/** Keyed by finding id: messages carry live numbers (latency, lag, counts) and would otherwise re-print every poll. */
export function diffFindings(
  prev: Finding[],
  next: Finding[]
): { added: Finding[]; changed: Finding[]; resolved: Finding[] } {
  const prevById = new Map(prev.map((finding) => [finding.id, finding]))
  const nextById = new Map(next.map((finding) => [finding.id, finding]))
  return {
    added: next.filter((finding) => !prevById.has(finding.id)),
    changed: next.filter((finding) => prevById.has(finding.id) && prevById.get(finding.id)!.level !== finding.level),
    resolved: prev.filter((finding) => !nextById.has(finding.id)),
  }
}
