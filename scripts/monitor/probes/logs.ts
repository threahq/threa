import { KNOWN_LOG_NOISE, PROD, THRESHOLDS } from "../config"
import type { RailwayClient, RailwayLogLine } from "../railway"
import type { Finding, Window } from "../types"

export interface LogTemplate {
  template: string
  count: number
  services: string[]
  sample: string
  firstAt: string
  lastAt: string
  noise: string | null
}

export interface LogServiceSummary {
  service: string
  errorSince: number
  errorPrior: number
  warnSince: number
  warnPrior: number
  noiseSince: number
}

export interface LogReport {
  window: Window
  services: LogServiceSummary[]
  templates: LogTemplate[]
  truncated: boolean
  findings: Finding[]
}

/** Collapses ids, hashes, numbers and timestamps so repeated lines group under one template. */
export function templateOf(message: string): string {
  return message
    .trim()
    .replace(/\b[a-z]+_[0-9A-Z]{20,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{24,}\b/gi, "<hex>")
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb|%)?\b/gi, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 200)
}

export function noiseReason(message: string): string | null {
  for (const entry of KNOWN_LOG_NOISE) if (entry.pattern.test(message)) return entry.why
  return null
}

/** Stack frames and blank lines arrive as their own Railway lines; fold them into the preceding event per service. */
export function collapseContinuations(lines: RailwayLogLine[]): RailwayLogLine[] {
  const out: RailwayLogLine[] = []
  const lastByService = new Map<string | null, RailwayLogLine>()
  for (const line of lines) {
    const isContinuation = line.message.trim() === "" || /^\s+at\s/.test(line.message) || /^\s{2,}\S/.test(line.message)
    const parent = lastByService.get(line.service)
    if (isContinuation) {
      if (parent && parent.message.split("\n").length < 4 && line.message.trim())
        parent.message = `${parent.message}\n${line.message.trimEnd()}`
      continue
    }
    const copy = { ...line }
    out.push(copy)
    lastByService.set(line.service, copy)
  }
  return out
}

export function groupTemplates(rawLines: RailwayLogLine[]): LogTemplate[] {
  const map = new Map<string, LogTemplate>()
  for (const line of collapseContinuations(rawLines)) {
    const template = templateOf(line.message.split("\n")[0])
    const cur = map.get(template)
    if (cur) {
      cur.count += 1
      cur.lastAt = line.timestamp
      if (line.service && !cur.services.includes(line.service)) cur.services.push(line.service)
    } else {
      map.set(template, {
        template,
        count: 1,
        services: line.service ? [line.service] : [],
        sample: line.message.slice(0, 300),
        firstAt: line.timestamp,
        lastAt: line.timestamp,
        noise: noiseReason(line.message),
      })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

function serviceFilter(): string {
  return PROD.logServices.map((s) => `@service:${s}`).join(" OR ")
}

export async function probeLogs(railway: RailwayClient, window: Window): Promise<LogReport> {
  const filter = (level: string) => `(@level:${level}) AND (${serviceFilter()})`
  const [errSince, errPrior, warnSince, warnPrior] = await Promise.all([
    railway.environmentLogs({ filter: filter("error"), after: window.since, limit: THRESHOLDS.logFetchLimit }),
    railway.environmentLogs({
      filter: filter("error"),
      after: window.priorStart,
      before: window.since,
      limit: THRESHOLDS.logFetchLimit,
    }),
    railway.environmentLogs({ filter: filter("warn"), after: window.since, limit: THRESHOLDS.logFetchLimit }),
    railway.environmentLogs({
      filter: filter("warn"),
      after: window.priorStart,
      before: window.since,
      limit: THRESHOLDS.logFetchLimit,
    }),
  ])
  return summarizeLogs(window, { errSince, errPrior, warnSince, warnPrior })
}

export function summarizeLogs(
  window: Window,
  lines: {
    errSince: RailwayLogLine[]
    errPrior: RailwayLogLine[]
    warnSince: RailwayLogLine[]
    warnPrior: RailwayLogLine[]
  }
): LogReport {
  const count = (arr: RailwayLogLine[], service: string, noise: boolean) =>
    collapseContinuations(arr).filter((l) => l.service === service && (noiseReason(l.message) !== null) === noise)
      .length
  const services: LogServiceSummary[] = PROD.logServices.map((service) => ({
    service,
    errorSince: count(lines.errSince, service, false),
    errorPrior: count(lines.errPrior, service, false),
    warnSince: count(lines.warnSince, service, false),
    warnPrior: count(lines.warnPrior, service, false),
    noiseSince: count(lines.errSince, service, true) + count(lines.warnSince, service, true),
  }))
  const templates = groupTemplates([...lines.errSince, ...lines.warnSince])
  const truncated = [lines.errSince, lines.errPrior, lines.warnSince, lines.warnPrior].some(
    (a) => a.length >= THRESHOLDS.logFetchLimit
  )
  const findings: Finding[] = []
  for (const s of services) {
    const floor = THRESHOLDS.logRateAbsoluteFloor
    const errBase = Math.max(s.errorPrior, floor)
    if (s.errorSince > errBase * THRESHOLDS.logRateWarnMultiplier) {
      findings.push({
        level: "warn",
        id: `logs.error.${s.service}`,
        message: `${s.service}: ${s.errorSince} error lines since baseline vs ${s.errorPrior} in the prior window`,
      })
    } else if (s.errorSince > 0 && s.errorPrior === 0) {
      findings.push({
        level: "warn",
        id: `logs.error.new.${s.service}`,
        message: `${s.service}: ${s.errorSince} error lines since baseline, none in the prior window`,
      })
    }
    const warnBase = Math.max(s.warnPrior, floor)
    if (s.warnSince > warnBase * THRESHOLDS.logRateWarnMultiplier) {
      findings.push({
        level: "warn",
        id: `logs.warn.${s.service}`,
        message: `${s.service}: ${s.warnSince} warn lines since baseline vs ${s.warnPrior} in the prior window`,
      })
    }
  }
  const priorTemplates = new Set(groupTemplates([...lines.errPrior, ...lines.warnPrior]).map((t) => t.template))
  for (const t of templates) {
    if (t.noise || priorTemplates.has(t.template) || t.count < 3) continue
    findings.push({
      level: "warn",
      id: `logs.template.${t.template.slice(0, 60)}`,
      message: `new log template ×${t.count} [${t.services.join(",")}]: ${t.sample.slice(0, 140)}`,
    })
  }
  if (truncated)
    findings.push({
      level: "warn",
      id: "logs.truncated",
      message: `log fetch hit the ${THRESHOLDS.logFetchLimit}-line cap; counts are lower bounds`,
    })
  return { window, services, templates, truncated, findings }
}
