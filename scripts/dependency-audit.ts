#!/usr/bin/env bun
import { writeFile } from "node:fs/promises"

export interface AuditAdvisory {
  readonly id: number
  readonly url: string
  readonly title: string
  readonly severity: string
}

export type AuditResult = Record<string, readonly AuditAdvisory[]>

export interface AuditReport {
  readonly ok: boolean
  readonly packages: number
  /** Bun audit rows: the same advisory appears once per vulnerable version range. */
  readonly advisories: number
  /** Distinct advisories by URL. */
  readonly distinctAdvisories: number
  readonly bySeverity: Record<string, number>
  readonly result: AuditResult
}

const SEVERITY_ORDER = ["critical", "high", "moderate", "low"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAdvisory(value: unknown): value is AuditAdvisory {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.severity === "string" &&
    SEVERITY_ORDER.includes(value.severity as (typeof SEVERITY_ORDER)[number])
  )
}

export function parseAudit(stdout: string): AuditResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error("bun audit output is not valid JSON")
  }
  if (!isRecord(parsed)) {
    throw new Error("bun audit output is not a package -> advisories map")
  }
  for (const [name, advisories] of Object.entries(parsed)) {
    if (!Array.isArray(advisories) || !advisories.every(isAdvisory)) {
      throw new Error(`bun audit entry for "${name}" is not an advisory list`)
    }
  }
  return parsed as AuditResult
}

export function buildReport(result: AuditResult): AuditReport {
  const bySeverity: Record<string, number> = {}
  const distinctUrls = new Set<string>()
  let advisories = 0
  for (const list of Object.values(result)) {
    for (const advisory of list) {
      advisories += 1
      distinctUrls.add(advisory.url)
      bySeverity[advisory.severity] = (bySeverity[advisory.severity] ?? 0) + 1
    }
  }
  return {
    ok: true,
    packages: Object.keys(result).length,
    advisories,
    distinctAdvisories: distinctUrls.size,
    bySeverity,
    result,
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function escapeTableCell(value: string): string {
  return escapeHtml(value)
    .replace(/[\\\[\]`*_]/g, "\\$&")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]/g, " ")
}

function markdownLinkUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:") return null
    return parsed.href.replaceAll("(", "%28").replaceAll(")", "%29")
  } catch {
    return null
  }
}

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = []
  if (report.advisories === 0) {
    lines.push(
      "## Dependency advisory report",
      "",
      "The audit ran successfully and reported no known advisories for the resolved lockfile.",
      ""
    )
  } else {
    const counts = SEVERITY_ORDER.filter((s) => report.bySeverity[s]).map((s) => `${report.bySeverity[s]} ${s}`)
    lines.push(
      "## Dependency advisory report",
      "",
      `Found **${report.advisories} advisory entries** (${report.distinctAdvisories} distinct advisories) across ${report.packages} packages (${counts.join(", ")}).`,
      "",
      "A passing run means the report was generated, never that the tree is clear.",
      "An advisory can have multiple affected-version entries, so the entry count can exceed the distinct count.",
      "These findings are unresolved.",
      "",
      "| Package | Severity | Advisory |",
      "|---|---|---|"
    )
    const entries = Object.entries(report.result)
    for (const [pkg, list] of entries) {
      for (const advisory of list) {
        const title = escapeTableCell(advisory.title)
        const link = markdownLinkUrl(advisory.url)
        const advisoryCell =
          link === null ? `URL not https, see artifact: ${escapeTableCell(advisory.url)}` : `[${title}](${link})`
        lines.push(`| ${escapeTableCell(pkg)} | ${escapeTableCell(advisory.severity)} | ${advisoryCell} |`)
      }
    }
  }
  return lines.join("\n") + "\n"
}

async function main(): Promise<void> {
  const proc = Bun.spawnSync(["bun", "audit", "--json"], { stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(`bun audit exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`)
  }
  const report = buildReport(parseAudit(proc.stdout.toString()))
  if (proc.exitCode === 1 && report.advisories === 0) {
    throw new Error("bun audit exited 1 without advisory findings")
  }

  const markdown = renderMarkdown(report)
  await writeFile("dependency-audit.json", JSON.stringify(report, null, 2))
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown)
  } else {
    process.stdout.write(markdown)
  }
  console.log(
    report.advisories === 0
      ? "Report generated: the scanner reported no known advisories."
      : `Report generated: ${report.advisories} advisory entries (${report.distinctAdvisories} distinct) across ${report.packages} packages. Findings are unresolved.`
  )
}

if (import.meta.main) {
  await main()
}
