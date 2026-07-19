/**
 * Run the whole control-plane hostile matrix (Half A) and print an aggregate
 * pass/fail table. Each matrix runs as its OWN subprocess for isolation (matrix-2
 * SIGKILLs a backend; a leaked port or wedged pool can't bleed into the next
 * matrix). Parses each child's `__MATRIX_RESULT__` line and exits non-zero if any
 * matrix failed.
 *
 *   bun apps/backend/scripts/calls-spike/run-all.ts
 *
 * Knobs: forwards the environment, so CALLS_SPIKE_DB_URL / CALLS_SPIKE_VERBOSE /
 * CALLS_SPIKE_GLARE_N apply. Writes the raw results to last-results.json alongside.
 */

import { parseResultLine, type MatrixResult } from "./harness"

const MATRICES = [
  "matrix-1-two-instances.ts",
  "matrix-2-kill9.ts",
  "matrix-3-two-devices.ts",
  "matrix-4-glare.ts",
  "matrix-5-grace-revive.ts",
]

const here = new URL(".", import.meta.url).pathname

async function runOne(file: string): Promise<MatrixResult> {
  const started = Date.now()
  const proc = Bun.spawn(["bun", `${here}${file}`], {
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const parsed = parseResultLine(out)
  const durationMs = Date.now() - started
  if (!parsed) {
    return {
      matrix: file,
      pass: false,
      checks: [],
      metrics: { durationMs },
      error: `no result line (exit ${proc.exitCode}). stderr tail: ${err.split("\n").slice(-6).join(" | ")}`,
    }
  }
  parsed.metrics.durationMs = durationMs
  return parsed
}

async function main() {
  console.log("Calls spike — control-plane hostile matrix (Half A)\n")
  const results: MatrixResult[] = []
  for (const file of MATRICES) {
    process.stdout.write(`▶ ${file} … `)
    const r = await runOne(file)
    results.push(r)
    console.log(r.pass ? `PASS (${r.metrics.durationMs}ms)` : `FAIL (${r.error ?? "checks failed"})`)
  }

  console.log("\n──────────────── SUMMARY ────────────────")
  for (const r of results) {
    console.log(`\n${r.pass ? "PASS" : "FAIL"}  ${r.matrix}`)
    for (const c of r.checks) console.log(`   ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)
    if (Object.keys(r.metrics).length) console.log(`   metrics ${JSON.stringify(r.metrics)}`)
    if (r.error) console.log(`   error: ${r.error}`)
  }

  const passed = results.filter((r) => r.pass).length
  console.log(`\n${passed}/${results.length} matrices passed`)

  await Bun.write(`${here}last-results.json`, JSON.stringify(results, null, 2))
  console.log(`Raw results → ${here}last-results.json`)

  process.exit(passed === results.length ? 0 : 1)
}

main()
