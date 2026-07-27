import { describe, test, expect } from "bun:test"
import { ESLint, type Linter } from "eslint"
import tsParser from "@typescript-eslint/parser"
import threaPlugin, { sqlTextAssertionAllowlist } from "../../../../eslint/threa-plugin.js"

/**
 * The ratchet half of INV-68: SQL correctness is verified against a real schema,
 * never by asserting on the query TEXT a repository emits.
 *
 * `expect(captured.text).toContain("INSERT INTO widgets")` proves the string was
 * built. It cannot prove the statement runs: not that the columns exist, not
 * that an `ON CONFLICT` clause matches a real index, not that a join finds rows.
 * Two production incidents came from exactly that gap — `SELECT th.name` against
 * a column renamed in 2025 (every feed read would have thrown), and
 * `WHERE workspace_id = $1` against `messages`, which has no such column (every
 * backfill plan dead-lettered for a month with no user-visible signal). Both
 * shipped through green unit suites, a clean typecheck and CI.
 *
 * DETECTION lives in the `threa/no-sql-text-assertion` ESLint rule, so a
 * violation is red in the editor and fails `bun run lint`. What ESLint cannot do
 * is notice a count going DOWN — it only ever sees the violations that remain.
 * That is this test's job: it runs the same rule over every scanned tree and
 * holds each file to its recorded number, so converting assertions to
 * integration tests must be recorded, and adding one cannot pass unnoticed.
 *
 * The counts live in `sqlTextAssertionAllowlist` (eslint/threa-plugin.js), which
 * `eslint.config.js` also reads to exempt those same files — one list, so lint
 * and the ratchet can never disagree about what is grandfathered (INV-33).
 */

const REPO_ROOT = resolveRepoRoot()
const SCANNED_GLOBS = [
  "apps/backend/src/**/*.test.ts",
  "apps/control-plane/src/**/*.test.ts",
  "packages/backend-common/src/**/*.test.ts",
]
const RULE = "threa/no-sql-text-assertion"

function resolveRepoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "")
}

/** The rule alone, ignoring every project config, so all three trees are held to one standard. */
function lintConfig(): Linter.Config {
  return {
    files: ["**/*.test.ts"],
    languageOptions: {
      parser: tsParser as Linter.Parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { threa: threaPlugin },
    rules: { [RULE]: "error" },
  }
}

async function countViolations(patterns: string[]): Promise<Record<string, number>> {
  const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: true, overrideConfig: lintConfig() })
  const results = await eslint.lintFiles(patterns)
  const counts: Record<string, number> = {}
  for (const result of results) {
    const fatal = result.messages.find((message) => message.fatal)
    if (fatal) throw new Error(`${result.filePath} failed to parse: ${fatal.message}`)
    const count = result.messages.filter((message) => message.ruleId === RULE).length
    if (count > 0) counts[result.filePath.slice(REPO_ROOT.length + 1)] = count
  }
  return counts
}

describe("SQL correctness is verified against a real schema, not by asserting on query text", () => {
  test("no test asserts on emitted SQL beyond the recorded ratchet", async () => {
    const found = await countViolations(SCANNED_GLOBS)

    const offences = [...new Set([...Object.keys(found), ...Object.keys(sqlTextAssertionAllowlist)])]
      .sort()
      .filter((path) => (found[path] ?? 0) !== (sqlTextAssertionAllowlist[path] ?? 0))
      .map((path) => `${path}: allowed ${sqlTextAssertionAllowlist[path] ?? 0}, found ${found[path] ?? 0}`)

    expect(
      offences,
      `SQL-text assertions moved off their recorded baseline.\n\n` +
        `Went UP, or a file appeared: an assertion on a query's TEXT does not ` +
        `verify the query. Move it to apps/backend/tests/integration/ — seed ` +
        `rows, run the statement, assert on what comes back — or, if the claim ` +
        `is genuinely about shape and has no runtime equivalent, drop it and ` +
        `name the surviving test so nobody reads it as behavioural coverage.\n\n` +
        `Went DOWN: thank you — lower the number in sqlTextAssertionAllowlist ` +
        `(eslint/threa-plugin.js), or delete the entry.\n\n${offences.join("\n")}`
    ).toEqual([])
  }, 120_000)

  // The rule is the detector, so its blind spots are what matter. These pin the
  // shapes a name-only or literal-only detector misses, and — just as important
  // — the ones it must leave alone: `.text` is prompt text and trace-step text
  // in this codebase too, and a fake Querier that ROUTES on query text is legal.
  const CASES: Array<{ code: string; flagged: boolean; why: string }> = [
    { code: `expect(captured.text).toContain("INSERT INTO widgets")`, flagged: true, why: "the canonical form" },
    { code: `expect(sql).toContain("FROM calls")`, flagged: true, why: "subject aliased to `sql`" },
    {
      code: `expect(reRead).toContain("SELECT s.workspace_id")`,
      flagged: true,
      why: "subject named nothing in particular",
    },
    {
      code: `expect(availableQuery).toContain("CASE WHEN i.trigger = 'x' THEN 1 END")`,
      flagged: true,
      why: "`*Query` suffix",
    },
    { code: `expect(captured.text).toContain(expectedSql)`, flagged: true, why: "expected statement built elsewhere" },
    {
      code: `expect(query.text).toContain("workspace_id = $2")`,
      flagged: true,
      why: "fragment with no SQL keyword in it",
    },
    { code: `expect(queries[0]!.text).not.toContain("ORDER BY")`, flagged: true, why: "negated, and indexed" },
    { code: `expect(text).toMatch(/DELETE FROM saved_messages/)`, flagged: true, why: "regex literal, not a string" },
    {
      code: `expect(digest!.text).toContain("Trigger message:")`,
      flagged: false,
      why: "a session digest is not a statement",
    },
    { code: `expect(text).toContain("## Previous sessions")`, flagged: false, why: "bare `text` is prompt text too" },
    { code: `expect(result).toBe("Message from deleted user")`, flagged: false, why: "lowercase `from` is English" },
    {
      code: `expect(err.message).toBe("Can only join public channels")`,
      flagged: false,
      why: "lowercase `join` is English",
    },
    {
      code: `expect(captured.publicKey).toEqual(Buffer.from([1, 2]))`,
      flagged: false,
      why: "`Buffer.from` is not SQL",
    },
    { code: `if (text.includes("INSERT INTO widgets")) return rows`, flagged: false, why: "routing, not asserting" },
  ]

  test.each(CASES)("$why", async ({ code, flagged }) => {
    const linter = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: true, overrideConfig: lintConfig() })
    const [result] = await linter.lintText(code, { filePath: `${REPO_ROOT}/case.test.ts` })

    expect(result!.messages.some((message) => message.ruleId === RULE)).toBe(flagged)
  })
})
