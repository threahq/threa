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

/** INV-1 / INV-3: scan executable DDL for banned constructs. */
async function checkContent(migrations: string[]): Promise<string[]> {
  const violations: string[] = []
  for (const path of migrations) {
    const sql = stripSqlComments(await readFile(resolve(REPO_ROOT, path), "utf-8"))
    for (const rule of CONTENT_RULES) {
      if (rule.pattern.test(sql)) {
        violations.push(`  ❌ ${path} — ${rule.inv}: ${rule.message}`)
      }
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
        "are enforced here. See CLAUDE.md → Data Model and Persistence Safety."
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
