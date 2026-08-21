import type { Finding, Level } from "./types"
import type { Snapshot } from "./snapshot"
import type { RevisionReport } from "./probes/revision"
import type { LogReport } from "./probes/logs"

const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗", pending: "…", skipped: "-" }

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function fmtAge(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime()
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${m % 60}m ago` : `${Math.floor(h / 24)}d ago`
}

export function renderRevision(r: RevisionReport, now: Date): string[] {
  const w = Math.max(...r.planes.map((p) => p.plane.length))
  const lines = [`revision  expected ${r.expected.slice(0, 8)}`]
  for (const p of r.planes) {
    const age = p.deployedAt ? ` (${fmtAge(p.deployedAt, now)})` : ""
    lines.push(`  ${MARK[p.level]} ${pad(p.plane, w)}  ${pad(p.live?.slice(0, 8) ?? "?", 8)}  ${p.detail}${age}`)
  }
  return lines
}

export function renderLogs(l: LogReport, top: number): string[] {
  const lines = [`logs      ${l.window.label}; prior window equal length`]
  for (const s of l.services) {
    lines.push(
      `  ${pad(s.service, 14)} error ${s.errorSince} (prior ${s.errorPrior})  warn ${s.warnSince} (prior ${s.warnPrior})${s.noiseSince ? `  noise ${s.noiseSince}` : ""}`
    )
  }
  const shown = l.templates.filter((t) => !t.noise).slice(0, top)
  if (shown.length) lines.push("  top templates:")
  for (const t of shown)
    lines.push(
      `    ×${pad(String(t.count), 4)} [${t.services.join(",")}] ${t.sample.slice(0, 150).replace(/\n/g, " ")}`
    )
  if (l.truncated) lines.push("  (fetch capped; counts are lower bounds)")
  return lines
}

export function renderSnapshot(s: Snapshot, opts: { top?: number } = {}): string {
  const now = new Date(s.at)
  const out: string[] = []
  out.push(`${MARK[s.level]} ${s.level.toUpperCase()}  ${s.at.slice(0, 19)}Z  ${s.window.label}`)
  if (s.revision) out.push(...renderRevision(s.revision, now))
  if (s.liveness) {
    out.push("liveness")
    const w = Math.max(...s.liveness.checks.map((c) => c.name.length))
    for (const c of s.liveness.checks) out.push(`  ${MARK[c.level]} ${pad(c.name, w)}  ${c.detail}`)
  }
  if (s.pipelines) {
    const p = s.pipelines
    const active = p.outbox.listeners.filter((l) => l.lag > 0)
    out.push(
      `pipelines outbox head ${p.outbox.head}, ${p.outbox.listeners.length} listeners, ${active.length ? active.map((l) => `${l.listener_id} lag ${l.lag}`).join(", ") : "all caught up"}; dead letters ${p.deadLetters.since} (prior ${p.deadLetters.prior})`
    )
    const busy = p.queues.filter((q) => q.running || q.ready || q.dlq_since || q.done_since)
    for (const q of busy) {
      out.push(
        `  ${pad(q.queue_name, 30)} running ${q.running}  ready ${q.ready}${q.oldest_ready_sec ? ` (oldest ${q.oldest_ready_sec}s)` : ""}  done ${q.done_since} (prior ${q.done_prior})${q.dlq_since || q.dlq_prior ? `  dlq ${q.dlq_since} (prior ${q.dlq_prior})` : ""}`
      )
    }
    const idle = p.queues.length - busy.length
    if (idle) out.push(`  ${idle} idle queues`)
    for (const c of p.counters) if (c.since || c.prior) out.push(`  ${pad(c.metric, 30)} ${c.since} (prior ${c.prior})`)
  }
  if (s.logs) out.push(...renderLogs(s.logs, opts.top ?? 5))
  if (s.resources) {
    out.push("resources")
    for (const r of s.resources.rows) {
      const cpu = r.cpuNow === null ? "?" : `${(r.cpuNow * 1000).toFixed(0)}m`
      const mem = r.memNowGb === null ? "?" : `${(r.memNowGb * 1024).toFixed(0)}MB`
      const memPeak =
        r.memMaxSinceGb !== null && r.memMaxPriorGb !== null
          ? ` (peak ${(r.memMaxSinceGb * 1024).toFixed(0)}MB vs prior ${(r.memMaxPriorGb * 1024).toFixed(0)}MB)`
          : ""
      out.push(`  ${pad(r.service, 14)} cpu ${cpu}  mem ${mem}${memPeak}`)
    }
  }
  if (s.findings.length) {
    out.push("findings")
    for (const f of s.findings) out.push(`  ${MARK[f.level]} ${f.message}`)
  } else {
    out.push("findings  none")
  }
  return out.join("\n")
}

export function diffFindings(prev: Finding[], next: Finding[]): { added: Finding[]; resolved: Finding[] } {
  const prevIds = new Map(prev.map((f) => [f.id, f]))
  const nextIds = new Map(next.map((f) => [f.id, f]))
  return {
    added: next.filter((f) => !prevIds.has(f.id) || prevIds.get(f.id)!.message !== f.message),
    resolved: prev.filter((f) => !nextIds.has(f.id)),
  }
}
