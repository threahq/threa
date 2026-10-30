import type { JSONReport, JSONReportSpec, JSONReportSuite } from "@playwright/test/reporter"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs"
import * as path from "path"

interface TimingHistory {
  version: 1
  groups: Record<string, { durationMs: number; testCount: number }>
}

export interface ShardPlan {
  shards: { groups: string[]; estimatedDurationMs: number; testCount: number }[]
  fallbackGroupCount: number
}

function readReport(file: string): JSONReport {
  const text = readFileSync(file, "utf8")
  const start = text.indexOf("{")
  if (start < 0) throw new Error(`${file}: no JSON object found`)
  try {
    const report = JSON.parse(text.slice(start)) as JSONReport
    if (!Array.isArray(report.suites) || !report.stats) throw new Error("missing suites or stats")
    return report
  } catch (error) {
    throw new Error(`${file}: malformed Playwright JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function specs(report: JSONReport): JSONReportSpec[] {
  const found: JSONReportSpec[] = []
  const visit = (suite: JSONReportSuite) => {
    for (const spec of suite.specs ?? []) found.push(spec)
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites) visit(suite)
  return found
}

function identity(project: string, file: string): string {
  return `[${project}] > ${file.replaceAll("\\", "/")}`
}

function markdownReport(report: JSONReport, shard: string): { markdown: string; unexecuted: number } {
  let passed = 0
  let failed = 0
  let skipped = 0
  let unexecuted = 0
  let durationMs = 0
  const failureNames: string[] = []

  for (const spec of specs(report)) {
    for (const test of spec.tests) {
      const first = test.results?.find((result) => (result.retry ?? 0) === 0)
      if (!first) {
        unexecuted++
        continue
      }
      durationMs += first.duration ?? 0
      if (first.status === "passed") passed++
      else if (first.status === "skipped" || test.expectedStatus === "skipped") skipped++
      else {
        failed++
        failureNames.push(`${identity(test.projectName, spec.file)} › ${spec.title}`)
      }
    }
  }

  const attempted = passed + failed
  if (attempted + skipped + unexecuted === 0) throw new Error("report contains no tests")
  const lines = [
    `### Shard ${shard} first attempt`,
    "",
    `Passed/attempted: **${passed}/${attempted}** · skipped: **${skipped}** · unexecuted: **${unexecuted}** · duration: **${(durationMs / 1000).toFixed(1)}s**`,
  ]
  if (failureNames.length) {
    lines.push("", "First-attempt failures (including retry-green tests):", ...failureNames.map((name) => `- ${name}`))
  }
  return { markdown: `${lines.join("\n")}\n`, unexecuted }
}

function inventoryGroups(report: JSONReport): Map<string, number> {
  const groups = new Map<string, number>()
  for (const spec of specs(report)) {
    for (const test of spec.tests) {
      const key = identity(test.projectName, spec.file)
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
  }
  if (!groups.size) throw new Error("inventory contains no tests")
  return groups
}

function browserSpecPath(group: string): string {
  return `tests/browser/${path.basename(group.replace(/^\[[^\]]+\] > /, ""))}`
}

export function planShards(
  report: JSONReport,
  history: TimingHistory | undefined,
  shardCount: number,
  files?: string[]
): ShardPlan {
  const inventory = inventoryGroups(report)
  if (files) {
    if (
      !files.length ||
      files.some((file) => typeof file !== "string" || !/^tests\/browser\/[^/]+\.spec\.ts$/.test(file))
    )
      throw new Error("invalid selected browser files")
    const selected = new Set(files)
    if (selected.size !== files.length) throw new Error("duplicate selected browser files")
    const available = new Set([...inventory.keys()].map(browserSpecPath))
    for (const file of files)
      if (!available.has(file)) throw new Error(`selected browser file missing from inventory: ${file}`)
    for (const key of inventory.keys()) if (!selected.has(browserSpecPath(key))) inventory.delete(key)
  }
  if (inventory.size < shardCount) throw new Error(`inventory has ${inventory.size} groups for ${shardCount} shards`)
  const observations = Object.fromEntries(
    Object.entries(history?.groups ?? {}).filter(([, group]) => group.durationMs > 0 && group.testCount > 0)
  )
  const observedGroups = Object.values(observations)
  const observedPerTest = observedGroups.length
    ? observedGroups.reduce((sum, group) => sum + group.durationMs, 0) /
      observedGroups.reduce((sum, group) => sum + group.testCount, 0)
    : 1000
  let fallbackGroupCount = 0
  const weighted = [...inventory].map(([key, testCount]) => {
    const prior = observations[key]
    if (!prior) fallbackGroupCount++
    return {
      key,
      testCount,
      durationMs: testCount * (prior ? prior.durationMs / prior.testCount : observedPerTest),
    }
  })
  weighted.sort((a, b) => b.durationMs - a.durationMs || a.key.localeCompare(b.key))

  const shards: ShardPlan["shards"] = Array.from({ length: shardCount }, () => ({
    groups: [],
    estimatedDurationMs: 0,
    testCount: 0,
  }))
  for (const group of weighted) {
    let target = shards[0]!
    for (let i = 1; i < shardCount; i++) {
      if (shards[i]!.estimatedDurationMs < target.estimatedDurationMs) target = shards[i]!
    }
    target.groups.push(group.key)
    target.estimatedDurationMs += group.durationMs
    target.testCount += group.testCount
  }
  if (shards.some((shard) => !shard.groups.length)) throw new Error("planner produced an empty shard")
  return { shards, fallbackGroupCount }
}

function historyFromReports(reports: JSONReport[]): TimingHistory {
  const groups: TimingHistory["groups"] = {}
  for (const report of reports) {
    for (const spec of specs(report)) {
      for (const test of spec.tests) {
        const passing = test.results?.find((result) => result.status === "passed")
        if (!passing || !(passing.duration > 0)) continue
        const key = identity(test.projectName, spec.file)
        const group = (groups[key] ??= { durationMs: 0, testCount: 0 })
        group.durationMs += passing.duration ?? 0
        group.testCount++
      }
    }
  }
  return { version: 1, groups }
}

function value(args: string[], name: string, required = true): string | undefined {
  const index = args.indexOf(name)
  const result = index >= 0 ? args[index + 1] : undefined
  if (required && !result) throw new Error(`missing ${name}`)
  return result
}

export function main(args = process.argv.slice(2)): void {
  const command = args[0]
  if (command === "report") {
    const output = value(args, "--output")!
    const summary = markdownReport(readReport(value(args, "--report")!), value(args, "--shard")!)
    writeFileSync(output, summary.markdown)
    if (summary.unexecuted > 0) throw new Error(`report contains ${summary.unexecuted} unexecuted tests`)
    return
  }
  if (command === "plan") {
    const historyFile = value(args, "--history", false)
    const history =
      historyFile &&
      (() => {
        const parsed = JSON.parse(readFileSync(historyFile, "utf8")) as TimingHistory | JSONReport
        if ("suites" in parsed) return historyFromReports([parsed])
        if (parsed.version !== 1 || !parsed.groups) throw new Error(`${historyFile}: invalid browser timing history`)
        return parsed
      })()
    const shardCount = Number(value(args, "--shards")!)
    const outputDir = value(args, "--output-dir")!
    const filesPath = value(args, "--files", false)
    const files = filesPath ? (JSON.parse(readFileSync(filesPath, "utf8")) as string[]) : undefined
    if (files && !Array.isArray(files)) throw new Error("selected browser files must be an array")
    const plan = planShards(readReport(value(args, "--inventory")!), history, shardCount, files)
    mkdirSync(outputDir, { recursive: true })
    for (const [index, shard] of plan.shards.entries())
      writeFileSync(path.join(outputDir, `shard-${index + 1}.txt`), `${shard.groups.join("\n")}\n`)
    const summary = [
      "## Browser shard plan",
      "",
      `Fallback groups without history: **${plan.fallbackGroupCount}**`,
      "",
      "| Shard | Groups | Tests | Estimated work |",
      "|---:|---:|---:|---:|",
      ...plan.shards.map(
        (shard, i) =>
          `| ${i + 1} | ${shard.groups.length} | ${shard.testCount} | ${(shard.estimatedDurationMs / 1000).toFixed(1)}s |`
      ),
      "",
    ].join("\n")
    writeFileSync(value(args, "--summary")!, summary)
    return
  }
  if (command === "merge-timings") {
    const root = value(args, "--reports-dir")!
    const shardCount = Number(value(args, "--shards")!)
    const files = readdirSync(root, { recursive: true })
      .filter((entry) => String(entry).endsWith("initial-report.json"))
      .map((entry) => path.join(root, String(entry)))
    if (files.length !== shardCount)
      throw new Error(`expected ${shardCount} initial shard reports, found ${files.length}`)
    const reportsByShard = new Map<number, JSONReport>()
    for (const file of files) {
      const match = file.match(/shard-result-(\d+)-attempt-/)
      if (!match) throw new Error(`cannot identify shard from ${file}`)
      const shard = Number(match[1])
      if (reportsByShard.has(shard)) throw new Error(`duplicate initial report for shard ${shard}`)
      reportsByShard.set(shard, readReport(file))
    }
    for (let shard = 1; shard <= shardCount; shard++)
      if (!reportsByShard.has(shard)) throw new Error(`missing initial report for shard ${shard}`)
    const history = historyFromReports([...reportsByShard.values()])
    if (!Object.keys(history.groups).length) throw new Error("reports contain no usable timings")
    writeFileSync(value(args, "--output")!, `${JSON.stringify(history, null, 2)}\n`)
    return
  }
  throw new Error("usage: browser-ci.ts report|plan|merge-timings ...")
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
