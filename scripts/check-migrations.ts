#!/usr/bin/env bun
/**
 * Lint: enforce the data-model invariants that live in SQL migrations so they
 * are caught for free in CI instead of by a per-PR reviewer (or CodeRabbit).
 *
 * - INV-1: no foreign keys. Relational integrity is enforced in application
 *   code, not the schema, because workspace is the sharding boundary (INV-8)
 *   and cross-shard FKs don't hold.
 * - INV-3: no DB enums. Use TEXT and validate in code, so adding a variant is
 *   a code change, not a migration + type alter.
 * - INV-17: migrations are append-only. A migration file that already exists on
 *   the base branch must never be edited or deleted — doing so diverges already
 *   applied databases from the file on disk.
 *
 * Run via `bun scripts/check-migrations.ts` (also wired into the root `lint`
 * script and the CI lint job).
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")

/** Every migration `.sql` under `apps/<service>/src/db/migrations/`. */
async function findMigrations(): Promise<string[]> {
  const result: string[] = []
  const glob = new Bun.Glob("apps/*/src/db/migrations/*.sql")
  for await (const path of glob.scan({ cwd: REPO_ROOT })) {
    result.push(path)
  }
  return result.sort()
}

/**
 * Strip SQL comments so keyword checks only see executable DDL. Removes
 * `--` line comments and `/* ... *\/` block comments. Migrations routinely
 * mention "foreign keys" and "references" in their header comments (they cite
 * the very invariants enforced here), so stripping is required to avoid false
 * positives.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")
}

interface ContentRule {
  readonly pattern: RegExp
  readonly inv: string
  readonly message: string
}

const CONTENT_RULES: readonly ContentRule[] = [
  {
    pattern: /\bFOREIGN\s+KEY\b/i,
    inv: "INV-1",
    message: "Foreign keys are not allowed; enforce relational integrity in application code.",
  },
  {
    // A bare REFERENCES keyword in executable DDL is a column-level FK constraint.
    pattern: /\bREFERENCES\b/i,
    inv: "INV-1",
    message: "Column-level REFERENCES is a foreign key; enforce relational integrity in application code.",
  },
  {
    pattern: /\bCREATE\s+TYPE\b[\s\S]*?\bAS\s+ENUM\b/i,
    inv: "INV-3",
    message: "DB enums are not allowed; use TEXT and validate the allowed values in code.",
  },
  {
    pattern: /\bENUM\s*\(/i,
    inv: "INV-3",
    message: "Inline ENUM column types are not allowed; use TEXT and validate the allowed values in code.",
  },
]

/**
 * INV-67: a migration that enqueues `backfill.plan` jobs must delay them
 * (`process_after = NOW() + interval ...`). The definition it names ships in the
 * same release, so an old-code replica that claims the job during a rolling
 * deploy throws `Unknown backfill` and burns its retries into the DLQ within
 * seconds — long before new code boots. Grandfathered: the mention backfill
 * predates the rule (its jobs have long since drained).
 */
const INV67_GRANDFATHERED = new Set(["20260621120000_backfill_mention_actor_refs.sql"])

/** Minutes represented by a SQL `INTERVAL '<n> <unit>'` literal, or 0 if unparseable. */
function intervalMinutes(literal: string): number {
  const match = literal.match(/^\s*(\d+(?:\.\d+)?)\s*(minute|minutes|hour|hours|day|days)\s*$/i)
  if (!match) return 0
  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  if (unit.startsWith("minute")) return value
  if (unit.startsWith("hour")) return value * 60
  return value * 60 * 24
}

/**
 * True when the `queue_messages` INSERT's OWN `process_after` expression is
 * `NOW() + INTERVAL '<n>'` with n >= 10 minutes. An interval elsewhere in the
 * migration must not satisfy the rule, so this locates `process_after` in the
 * INSERT's column list and inspects the value expression at the same position
 * (splitting SELECT/VALUES expressions at paren-depth 0).
 */
function hasDelayedProcessAfter(sql: string): boolean {
  const insertMatch = sql.match(/INSERT\s+INTO\s+queue_messages\s*\(([\s\S]*?)\)\s*(VALUES|SELECT)\s([\s\S]*?)(?:;|$)/i)
  if (!insertMatch) return false
  const columns = insertMatch[1].split(",").map((c) => c.trim().toLowerCase())
  const processAfterIndex = columns.indexOf("process_after")
  if (processAfterIndex === -1) return false

  let body = insertMatch[3]
  if (insertMatch[2].toUpperCase() === "VALUES") {
    const paren = body.match(/\(([\s\S]*?)\)\s*(?:,|$)/)
    if (!paren) return false
    body = paren[1]
  } else {
    // SELECT list ends at the FROM clause (if any).
    body = body.split(/\bFROM\b/i)[0]
  }

  const expressions: string[] = []
  let depth = 0
  let current = ""
  for (const char of body) {
    if (char === "(") depth++
    if (char === ")") depth--
    if (char === "," && depth === 0) {
      expressions.push(current)
      current = ""
      continue
    }
    current += char
  }
  expressions.push(current)

  const expr = expressions[processAfterIndex]?.trim() ?? ""
  const delay = expr.match(/^NOW\(\)\s*\+\s*INTERVAL\s*'([^']+)'$/i)
  return delay !== null && intervalMinutes(delay[1]) >= 10
}

/** INV-1 / INV-3 / INV-67: scan executable SQL for banned constructs. */
async function checkContent(migrations: string[]): Promise<string[]> {
  const violations: string[] = []
  for (const path of migrations) {
    const sql = stripSqlComments(await readFile(resolve(REPO_ROOT, path), "utf-8"))
    for (const rule of CONTENT_RULES) {
      if (rule.pattern.test(sql)) {
        violations.push(`  ❌ ${path} — ${rule.inv}: ${rule.message}`)
      }
    }
    const filename = path.split("/").pop() ?? path
    if (/'backfill\.plan'/.test(sql) && !INV67_GRANDFATHERED.has(filename) && !hasDelayedProcessAfter(sql)) {
      violations.push(
        `  ❌ ${path} — INV-67: backfill.plan enqueues must delay process_after by >= 10 minutes (NOW() + interval '10 minutes') to survive a rolling deploy.`
      )
    }
  }
  return violations
}

/**
 * INV-17: migrations are append-only. Compare against the merge-base with the
 * base branch; any migration file Modified or Deleted relative to it is a
 * violation. Best-effort — if the git context isn't available (shallow CI
 * clone with no base ref, not a worktree), skip with a notice rather than
 * failing, since the content checks above are the always-on core.
 */
async function checkAppendOnly(): Promise<{ violations: string[]; skipped: string | null }> {
  const base = process.env.BASE_REF ?? "origin/main"
  const mergeBase = await git(["merge-base", base, "HEAD"])
  if (mergeBase === null) {
    return { violations: [], skipped: `no merge-base with ${base}` }
  }

  const diff = await git(["diff", "--name-status", `${mergeBase}`, "HEAD", "--", "apps/*/src/db/migrations/*.sql"])
  if (diff === null) {
    return { violations: [], skipped: "git diff unavailable" }
  }

  const violations: string[] = []
  for (const line of diff.split("\n")) {
    if (!line.trim()) continue
    const [status, ...rest] = line.split("\t")
    const path = rest[rest.length - 1]
    // A = added (fine), M = modified, D = deleted, R = renamed.
    if (status.startsWith("M")) {
      violations.push(`  ❌ ${path} — INV-17: existing migration modified; migrations are append-only.`)
    } else if (status.startsWith("D")) {
      violations.push(`  ❌ ${path} — INV-17: existing migration deleted; migrations are append-only.`)
    } else if (status.startsWith("R")) {
      violations.push(`  ❌ ${path} — INV-17: existing migration renamed; migrations are append-only.`)
    }
  }
  return { violations, skipped: null }
}

async function git(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    return code === 0 ? out.trim() : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const migrations = await findMigrations()
  if (migrations.length === 0) {
    console.error("No migrations found under apps/*/src/db/migrations — repo layout changed?")
    process.exit(1)
  }

  const contentViolations = await checkContent(migrations)
  const { violations: appendOnlyViolations, skipped } = await checkAppendOnly()
  const violations = [...contentViolations, ...appendOnlyViolations]

  if (violations.length > 0) {
    console.error("\n❌ Migration invariant violations:\n")
    for (const v of violations) console.error(v)
    console.error(
      "\nINV-1 (no foreign keys), INV-3 (no DB enums), and INV-17 (append-only migrations)\n" +
        "are enforced here. See AGENTS.md → Invariants → Data & Persistence."
    )
    process.exit(1)
  }

  console.log(`✓ ${migrations.length} migrations clean (INV-1, INV-3, INV-17)`)
  if (skipped) console.log(`  (append-only check skipped: ${skipped})`)
}

main().catch((err) => {
  console.error("check-migrations failed:", err)
  process.exit(1)
})
