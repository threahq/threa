import { PROD, THRESHOLDS } from "../config"
import type { RailwayClient, RailwayMetricSeries } from "../railway"
import type { Finding, Window } from "../types"

export interface ResourceRow {
  service: string
  cpuNow: number | null
  cpuMaxSince: number | null
  cpuMaxPrior: number | null
  memNowGb: number | null
  memMaxSinceGb: number | null
  memMaxPriorGb: number | null
}

export interface ResourceReport {
  rows: ResourceRow[]
  findings: Finding[]
}

export function summarizeResources(
  series: RailwayMetricSeries[],
  names: Map<string, string>,
  window: Window
): ResourceReport {
  const sinceSec = new Date(window.since).getTime() / 1000
  const byService = new Map<string, ResourceRow>()
  const row = (id: string | null) => {
    const name = id ? (names.get(id) ?? id.slice(0, 8)) : "(environment)"
    let r = byService.get(name)
    if (!r) {
      r = {
        service: name,
        cpuNow: null,
        cpuMaxSince: null,
        cpuMaxPrior: null,
        memNowGb: null,
        memMaxSinceGb: null,
        memMaxPriorGb: null,
      }
      byService.set(name, r)
    }
    return r
  }
  for (const s of series) {
    if (!s.serviceId) continue
    const r = row(s.serviceId)
    const since = s.values.filter((v) => v.ts >= sinceSec).map((v) => v.value)
    const prior = s.values.filter((v) => v.ts < sinceSec).map((v) => v.value)
    const last = s.values.at(-1)?.value ?? null
    const max = (arr: number[]) => (arr.length ? Math.max(...arr) : null)
    if (s.measurement === "CPU_USAGE") {
      r.cpuNow = last
      r.cpuMaxSince = max(since)
      r.cpuMaxPrior = max(prior)
    } else if (s.measurement === "MEMORY_USAGE_GB") {
      r.memNowGb = last
      r.memMaxSinceGb = max(since)
      r.memMaxPriorGb = max(prior)
    }
  }
  const rows = [...byService.values()].sort((a, b) => a.service.localeCompare(b.service))
  const findings: Finding[] = []
  // Railway sums replicas per service, so peaks double during every rollover; compare the
  // current sample against the prior window's peak instead, and only for app services.
  for (const r of rows) {
    if (!(PROD.logServices as readonly string[]).includes(r.service)) continue
    if (
      r.memNowGb !== null &&
      r.memMaxPriorGb !== null &&
      r.memMaxPriorGb > 0 &&
      r.memNowGb > r.memMaxPriorGb * THRESHOLDS.memoryGrowthWarnMultiplier
    ) {
      findings.push({
        level: "warn",
        id: `resources.mem.${r.service}`,
        message: `${r.service}: memory now ${(r.memNowGb * 1024).toFixed(0)}MB vs prior-window peak ${(r.memMaxPriorGb * 1024).toFixed(0)}MB`,
      })
    }
    if (
      r.cpuNow !== null &&
      r.cpuMaxPrior !== null &&
      r.cpuMaxPrior > 0.05 &&
      r.cpuNow > r.cpuMaxPrior * THRESHOLDS.cpuGrowthWarnMultiplier
    ) {
      findings.push({
        level: "warn",
        id: `resources.cpu.${r.service}`,
        message: `${r.service}: CPU now ${r.cpuNow.toFixed(2)} vCPU vs prior-window peak ${r.cpuMaxPrior.toFixed(2)}`,
      })
    }
  }
  return { rows, findings }
}

export async function probeResources(railway: RailwayClient, window: Window): Promise<ResourceReport> {
  const [series, names] = await Promise.all([
    railway.metrics({ start: window.priorStart, measurements: ["CPU_USAGE", "MEMORY_USAGE_GB"] }),
    railway.getServiceNames(),
  ])
  return summarizeResources(series, names, window)
}
