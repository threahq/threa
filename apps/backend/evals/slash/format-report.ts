/**
 * Render an eval `--json` report into a GitHub-comment markdown overview, in
 * the same at-a-glance style the code-review skill uses: a marker line, a
 * verdict header, a summary table, per-permutation `<details>`, and a footer.
 *
 * Pure formatting — no I/O except the CLI wrapper at the bottom.
 */

export interface EvalCaseResult {
  caseId: string
  caseName: string
  passes: number
  runs: number
  passRate: number
  lastFailure: { name: string; details?: string | null }[] | null
}

export interface EvalPermutation {
  model: string
  temperature: number | null
  runs: number
  executedModels: Record<string, number>
  usage: { inputTokens: number; outputTokens: number; totalCost: number } | null
  totalDurationMs: number
  runEvaluations: { name: string; score: number; passed: boolean; details: string | null }[]
  cases: EvalCaseResult[]
}

export interface EvalReport {
  suites: { suiteName: string; permutations: EvalPermutation[] }[]
}

export interface FormatMeta {
  command: string
  sha: string
  runUrl: string
  /** Eval CLI exit code: 0 = every case cleared its threshold, non-zero otherwise. */
  exitCode: number
  /** True when the results JSON was produced (distinguishes threshold-fail from a crash). */
  hasResults: boolean
}

export const EVAL_REPORT_MARKER = "<!-- eval-report -->"

const shortModel = (m: string) => m.replace(/^openrouter:/, "")

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s - m * 60)}s`
}

function cell(text: string): string {
  // Keep table cells single-line and pipe-safe.
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim()
}

function truncate(text: string, max = 140): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

function caseStatus(c: EvalCaseResult): "green" | "flaky" | "red" {
  if (c.passRate >= 1) return "green"
  if (c.passRate <= 0) return "red"
  return "flaky"
}

function failureSummary(c: EvalCaseResult): string {
  if (!c.lastFailure || c.lastFailure.length === 0) return ""
  return c.lastFailure.map((f) => (f.details ? `${f.name}: ${f.details}` : f.name)).join("; ")
}

function permutationRow(suiteName: string, p: EvalPermutation): string {
  const green = p.cases.filter((c) => caseStatus(c) === "green").length
  const flaky = p.cases.filter((c) => caseStatus(c) === "flaky").length
  const red = p.cases.filter((c) => caseStatus(c) === "red").length
  const runEvals =
    p.runEvaluations.map((e) => `${e.passed ? "✅" : "❌"} ${e.name} ${e.score.toFixed(2)}`).join("<br>") || "—"
  const casesCell = `${green}/${p.cases.length}` + (flaky ? ` · ${flaky} flaky` : "") + (red ? ` · ${red} red` : "")
  const cost = p.usage ? `$${p.usage.totalCost.toFixed(4)}` : "—"
  return `| ${cell(suiteName)} | \`${cell(shortModel(p.model))}\` | ${casesCell} | ${runEvals} | ${cost} | ${fmtDuration(p.totalDurationMs)} |`
}

function permutationDetails(suiteName: string, p: EvalPermutation): string {
  const emoji = { green: "🟢", flaky: "🟡", red: "🔴" } as const
  // Order: red first, then flaky, then green — problems surface at the top.
  const rank = { red: 0, flaky: 1, green: 2 } as const
  const rows = [...p.cases]
    .sort((a, b) => rank[caseStatus(a)] - rank[caseStatus(b)])
    .map((c) => {
      const st = caseStatus(c)
      const failure = st === "green" ? "" : cell(truncate(failureSummary(c)))
      return `| ${emoji[st]} \`${cell(c.caseId)}\` | ${c.passes}/${c.runs} | ${failure} |`
    })
    .join("\n")

  const executed =
    Object.entries(p.executedModels)
      .map(([m, n]) => `\`${shortModel(m)}\` (${n})`)
      .join(", ") || "—"

  const belowThreshold = p.cases.filter((c) => caseStatus(c) !== "green").length
  const summary = `${suiteName} · ${shortModel(p.model)} — ${belowThreshold ? `${belowThreshold} case(s) below threshold` : "all green"}`

  return [
    `<details><summary>${cell(summary)}</summary>`,
    "",
    `| Case | Pass rate | Last failure |`,
    `| --- | --- | --- |`,
    rows,
    "",
    `Executed models: ${executed}`,
    "</details>",
  ].join("\n")
}

export function formatReport(report: EvalReport | null, meta: FormatMeta): string {
  const lines: string[] = [EVAL_REPORT_MARKER, "### 🧪 Eval report"]

  if (!report || !meta.hasResults) {
    lines.push(
      "",
      `💥 **The eval run crashed before producing results.** [View run logs](${meta.runUrl}).`,
      "",
      `**Command:** \`${meta.command}\` · **Commit:** \`${meta.sha.slice(0, 7)}\``,
      "",
      "🤖 eval-runner"
    )
    return lines.join("\n")
  }

  const perms = report.suites.flatMap((s) => s.permutations.map((p) => ({ suiteName: s.suiteName, p })))
  const flaky = perms.reduce((n, { p }) => n + p.cases.filter((c) => caseStatus(c) === "flaky").length, 0)
  const red = perms.reduce((n, { p }) => n + p.cases.filter((c) => caseStatus(c) === "red").length, 0)
  const totalCost = perms.reduce((sum, { p }) => sum + (p.usage?.totalCost ?? 0), 0)

  const verdict =
    meta.exitCode === 0
      ? "✅ **All cases cleared their pass-rate threshold.**"
      : `❌ **${red + flaky} case(s) below threshold** (${red} red, ${flaky} flaky).`

  lines.push(
    "",
    verdict,
    "",
    `**Command:** \`${meta.command}\` · **Commit:** \`${meta.sha.slice(0, 7)}\` · [run log](${meta.runUrl})`,
    "",
    `| Suite | Model | Cases | Run evals | Cost | Time |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...perms.map(({ suiteName, p }) => permutationRow(suiteName, p)),
    "",
    ...perms.map(({ suiteName, p }) => permutationDetails(suiteName, p)),
    "",
    `Total cost: $${totalCost.toFixed(4)}`,
    "",
    "🤖 eval-runner"
  )
  return lines.join("\n")
}

if (import.meta.main) {
  const path = process.env.EVAL_RESULTS_JSON
  const meta: FormatMeta = {
    command: process.env.EVAL_COMMAND ?? "/eval",
    sha: process.env.EVAL_SHA ?? "",
    runUrl: process.env.EVAL_RUN_URL ?? "",
    // `||` (not `??`) so an empty string from a step that died early defaults
    // to failure rather than parsing as 0 and showing a false green.
    exitCode: Number(process.env.EVAL_EXIT_CODE || "1"),
    hasResults: false,
  }
  let report: EvalReport | null = null
  if (path) {
    const file = Bun.file(path)
    if (await file.exists()) {
      try {
        report = (await file.json()) as EvalReport
        meta.hasResults = true
      } catch {
        report = null
      }
    }
  }
  process.stdout.write(formatReport(report, meta))
}
