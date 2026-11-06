import { PROD, THRESHOLDS } from "../config"
import { type ExceptionGroup, OTEL_SEVERITY, type PostHogClient } from "../posthog"
import type { RailwayLogLine } from "../railway"
import type { Finding, Window } from "../types"
import { exceedsPriorRate, type LogReport, summarizeLogs } from "./logs"

export interface PostHogReport {
  window: Window
  logs: LogReport
  exceptions: ExceptionGroup[]
  retainedFrom: string | null
  findings: Finding[]
}

export function exceptionLabel(e: ExceptionGroup): string {
  return `[${e.lib}] ${e.type}: ${e.value.slice(0, 120).replace(/\n/g, " ")}`
}

export async function probePostHog(client: PostHogClient, window: Window): Promise<PostHogReport> {
  const limit = THRESHOLDS.logFetchLimit
  const error = { minSeverity: OTEL_SEVERITY.error, limit }
  const warn = { minSeverity: OTEL_SEVERITY.warn, maxSeverity: OTEL_SEVERITY.error, limit }
  const [errSince, errPrior, warnSince, warnPrior, exceptions, retainedFrom] = await Promise.all([
    client.logs({ ...error, after: window.since }),
    client.logs({ ...error, after: window.priorStart, before: window.since }),
    client.logs({ ...warn, after: window.since }),
    client.logs({ ...warn, after: window.priorStart, before: window.since }),
    client.exceptionGroups({ priorStart: window.priorStart, since: window.since, limit }),
    client.logsRetainedFrom(),
  ])
  return summarizePostHog(window, {
    errSince,
    errPrior,
    warnSince,
    warnPrior,
    exceptions,
    exceptionsTruncated: exceptions.length >= limit,
    retainedFrom,
  })
}

export function summarizePostHog(
  window: Window,
  input: {
    errSince: RailwayLogLine[]
    errPrior: RailwayLogLine[]
    warnSince: RailwayLogLine[]
    warnPrior: RailwayLogLine[]
    exceptions: ExceptionGroup[]
    exceptionsTruncated: boolean
    retainedFrom: string | null
  }
): PostHogReport {
  const { exceptions: rawExceptions, exceptionsTruncated, retainedFrom, ...lines } = input
  const summarized = summarizeLogs(window, lines, { idPrefix: "posthog.logs", services: PROD.posthogLogServices })
  const priorIncomplete = retainedFrom !== null && window.priorStart < retainedFrom
  const logs: LogReport = priorIncomplete
    ? {
        ...summarized,
        findings: [
          ...summarized.findings.filter((f) => f.id === "posthog.logs.truncated"),
          {
            level: "warn",
            id: "posthog.logs.prior_incomplete",
            message: `PostHog retains logs from ${retainedFrom.slice(0, 16).replace("T", " ")}Z; the prior window starts earlier, so log rate findings are skipped (use --since <= half the retention)`,
          },
        ],
      }
    : summarized
  const exceptions = [...rawExceptions].sort((a, b) => b.since - a.since)
  const exceptionFindings: Finding[] = []
  for (const e of exceptions) {
    const key = e.issueId ?? `${e.lib}.${e.type}`
    if (exceedsPriorRate(e.since, e.prior)) {
      exceptionFindings.push({
        level: "warn",
        id: `posthog.exception.${key}`,
        message: `exception ×${e.since} since baseline vs ${e.prior} in the prior window ${exceptionLabel(e)}`,
      })
    } else if (e.since > 0 && e.prior === 0) {
      exceptionFindings.push({
        level: "warn",
        id: `posthog.exception.new.${key}`,
        message: `new exception ×${e.since} ${exceptionLabel(e)}`,
      })
    }
  }
  if (exceptionsTruncated)
    exceptionFindings.push({
      level: "warn",
      id: "posthog.exceptions.truncated",
      message: `exception fetch hit the ${THRESHOLDS.logFetchLimit}-group cap; quieter issues are missing`,
    })
  return { window, logs, exceptions, retainedFrom, findings: [...logs.findings, ...exceptionFindings] }
}
