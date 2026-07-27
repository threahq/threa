import { describe, test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

/**
 * Guard: a unit test must not verify a repository by asserting on the SQL TEXT
 * it emits.
 *
 * `expect(captured.text).toContain("INSERT INTO widgets")` proves the string
 * was built. It cannot prove the statement runs: not that the columns exist,
 * not that an `ON CONFLICT` clause matches a real index, not that a join finds
 * rows. Two production incidents came from exactly that gap — a `SELECT th.name`
 * against a column renamed in 2025 (every feed read would have thrown), and a
 * `WHERE workspace_id = $1` against `messages`, which has no such column
 * (every backfill plan dead-lettered before fanning out a single chunk, for a
 * month, with no user-visible signal). Both shipped through green unit suites,
 * a clean typecheck and CI.
 *
 * SQL correctness is verified against a real schema — `tests/integration/`,
 * which runs the statements and asserts on the rows that come back.
 *
 * This is a RATCHET, not a clean bill of health: the pattern predates the rule
 * across the files below, and the counts may only go down. Converting a file's
 * assertions to an integration test and lowering its number here is always
 * welcome; raising one, or adding a new file, is the thing this guard exists to
 * stop.
 */
const ALLOWED_SQL_TEXT_ASSERTIONS: Record<string, number> = {
  "apps/backend/src/features/agents/agent-config-override-repository.test.ts": 4,
  "apps/backend/src/features/agents/follow-up-repository.test.ts": 9,
  "apps/backend/src/features/agents/persona-attachment-repository.test.ts": 9,
  "apps/backend/src/features/agents/persona-config-draft-repository.test.ts": 7,
  "apps/backend/src/features/agents/persona-config-revision-repository.test.ts": 6,
  "apps/backend/src/features/agents/persona-repository.test.ts": 5,
  "apps/backend/src/features/agents/session-repository.test.ts": 12,
  "apps/backend/src/features/ai-usage/usage-repository.test.ts": 3,
  "apps/backend/src/features/bot-access-requests/repository.test.ts": 4,
  "apps/backend/src/features/bot-runtimes/repository.test.ts": 18,
  "apps/backend/src/features/calls/repository.test.ts": 13,
  "apps/backend/src/features/delegations/repository.test.ts": 4,
  "apps/backend/src/features/drafts/repository.test.ts": 13,
  "apps/backend/src/features/e2e-streams/actor-repository.test.ts": 4,
  "apps/backend/src/features/e2e-streams/key-wrap-repository.test.ts": 4,
  "apps/backend/src/features/e2e-streams/repository.test.ts": 5,
  "apps/backend/src/features/enclave-runtimes/invocations-repository.test.ts": 13,
  "apps/backend/src/features/enclave-runtimes/repository.test.ts": 6,
  "apps/backend/src/features/enclave-runtimes/rewrap-notifications-repository.test.ts": 2,
  "apps/backend/src/features/memos/service.test.ts": 3,
  "apps/backend/src/features/saved-messages/repository.test.ts": 21,
  "apps/backend/src/features/scheduled-messages/repository.test.ts": 15,
  "apps/backend/src/features/search/repository.test.ts": 8,
  "apps/backend/src/features/streams/access.test.ts": 1,
  "apps/backend/src/features/streams/brief-repository.test.ts": 5,
  "apps/backend/src/features/streams/effective-read-state.test.ts": 1,
  "apps/backend/src/features/streams/policy-repository.test.ts": 7,
  "apps/backend/src/features/streams/read-state-repository.test.ts": 27,
  "apps/backend/src/features/streams/repository.test.ts": 2,
  "apps/backend/src/features/user-e2e-keys/repository.test.ts": 4,
  "apps/backend/src/features/workspace-integrations/installation-routes.test.ts": 3,
  "apps/backend/src/features/workspace-integrations/linear-write-guards.test.ts": 2,
  "apps/backend/src/features/workspace-settings/handlers.test.ts": 1,
  // Not debt: `composeSql` builds the statement, so its emitted text IS the unit
  // under test. Nothing here claims a schema is correct.
  "packages/backend-common/src/db/compose.test.ts": 8,
}

const REPO_ROOT = resolve(import.meta.dir, "../../../..")
const SCANNED_GLOBS = [
  "apps/backend/src/**/*.test.ts",
  "apps/control-plane/src/**/*.test.ts",
  "packages/backend-common/src/**/*.test.ts",
]

/**
 * The captured statement is what makes an assertion a SQL-text assertion, not
 * the fake that captured it. A fake Querier that ROUTES on query text to decide
 * which canned rows to return is fine — it is answering a query, not claiming
 * the query is correct — so the match is scoped to the inside of `expect(...)`
 * and its matcher chain.
 *
 * Two independent signals, either of which is enough. Naming alone missed a
 * whole file (`calls/repository.test.ts`) whose subject is just `sql`, and the
 * matcher side alone misses `expect(captured.text).toContain(expectedSql)`
 * where the expected statement is built elsewhere:
 *
 *   SUBJECT_NAMES_A_STATEMENT — `expect(captured.text)`, `expect(sql)`,
 *     `expect(queries[0].text)`, `expect(availableQuery)`
 *   MATCHER_HOLDS_SQL — `expect(reRead).toContain("FROM stream_read_state")`,
 *     regardless of what the subject is called
 *
 * SQL keywords stay CASE-SENSITIVE on purpose: matching `from`/`join`/`where`
 * case-insensitively flags ordinary English in prompt and error-message
 * assertions ("Spawned From", "Can only join public channels", `Buffer.from`).
 */
const SUBJECT_NAMES_A_STATEMENT = /\b(text|sql|query|queries|statement|captured)\b|\w+(Sql|Query|Statement)\b/
const MATCHER_HOLDS_SQL =
  /\.(?:toContain|toMatch|toStartWith|toInclude)\s*\([\s\S]{0,40}?(SELECT\s|INSERT INTO|UPDATE\s+[a-z_]|DELETE FROM|ON CONFLICT|JOIN\s+[a-z_]|WHERE\s+[a-z_]|GROUP BY|ORDER BY|PARTITION BY|UNNEST|unnest\(|ILIKE|RETURNING|FOR UPDATE|CASE WHEN|FROM\s+[a-z_])/
const SQL_KEYWORD =
  /\b(SELECT|INSERT INTO|UPDATE\s|DELETE FROM|ON CONFLICT|JOIN|WHERE|GROUP BY|ORDER BY|PARTITION BY|UNNEST|ILIKE|RETURNING|ROW_NUMBER|FOR UPDATE|CASE WHEN|COALESCE|FROM)\b/
/** `toContain(expectedSql)` — the statement is real, it is just declared elsewhere. */
const MATCHER_ARG_NAMES_A_STATEMENT =
  /\.(?:toContain|toMatch|toStartWith|toInclude|toEqual|toBe)\s*\(\s*[A-Za-z_$][\w$]*(?:Sql|Query|Statement)\b/

/** Consume a balanced `(...)` starting just after its opening paren. */
function skipBalanced(source: string, start: number): number {
  let index = start
  let depth = 1
  while (index < source.length && depth > 0) {
    const char = source[index]
    if (char === "(") depth++
    else if (char === ")") depth--
    index++
  }
  return index
}

interface Assertion {
  /** What `expect(...)` was handed. */
  subject: string
  /** The `.not.toContain(…)` tail. */
  matchers: string
  whole: string
}

/** Every `expect(...)` call in `source`, split at the end of its argument. */
function assertions(source: string): Assertion[] {
  const found: Assertion[] = []
  for (const match of source.matchAll(/\bexpect\s*\(/g)) {
    const open = match.index + match[0].length
    const afterSubject = skipBalanced(source, open)
    let index = afterSubject
    for (;;) {
      const chain = /^\s*\.[\w$]+(\s*\()?/.exec(source.slice(index))
      if (!chain) break
      index += chain[0].length
      if (chain[1]) index = skipBalanced(source, index)
    }
    found.push({
      subject: source.slice(open, afterSubject - 1),
      matchers: source.slice(afterSubject, index),
      whole: source.slice(match.index, index),
    })
  }
  return found
}

function assertsOnSql(assertion: Assertion): boolean {
  // A literal statement in the matcher is conclusive on its own — whatever the
  // subject is called, nothing but SQL gets compared against `FROM calls`.
  if (MATCHER_HOLDS_SQL.test(assertion.matchers)) return true
  if (!SUBJECT_NAMES_A_STATEMENT.test(assertion.subject)) return false
  return SQL_KEYWORD.test(assertion.whole) || MATCHER_ARG_NAMES_A_STATEMENT.test(assertion.matchers)
}

describe("SQL correctness is verified against a real schema, not by asserting on query text", () => {
  test("no unit test asserts on emitted SQL beyond the recorded ratchet", async () => {
    const found: Record<string, number> = {}
    for (const globPattern of SCANNED_GLOBS) {
      const glob = new Bun.Glob(globPattern)
      for await (const path of glob.scan({ cwd: REPO_ROOT })) {
        // This file's own failure message names the pattern it forbids.
        if (resolve(REPO_ROOT, path) === import.meta.path) continue
        const source = await readFile(resolve(REPO_ROOT, path), "utf-8")
        const count = assertions(source).filter(assertsOnSql).length
        if (count > 0) found[path] = count
      }
    }

    const offences = [...new Set([...Object.keys(found), ...Object.keys(ALLOWED_SQL_TEXT_ASSERTIONS)])]
      .sort()
      .filter((path) => (found[path] ?? 0) !== (ALLOWED_SQL_TEXT_ASSERTIONS[path] ?? 0))
      .map((path) => `${path}: allowed ${ALLOWED_SQL_TEXT_ASSERTIONS[path] ?? 0}, found ${found[path] ?? 0}`)

    expect(
      offences,
      `SQL-text assertions moved off their recorded baseline.\n\n` +
        `Went UP, or a file appeared: an assertion on a query's TEXT does not ` +
        `verify the query. Move it to apps/backend/tests/integration/ — seed ` +
        `rows, run the statement, assert on what comes back — or, if the claim ` +
        `is genuinely about shape and has no runtime equivalent, drop it and ` +
        `name the surviving test so nobody reads it as behavioural coverage.\n\n` +
        `Went DOWN: thank you — lower the number in ALLOWED_SQL_TEXT_ASSERTIONS ` +
        `(or delete the entry) so the ratchet holds.\n\n${offences.join("\n")}`
    ).toEqual([])
  })

  // The detector is a regex over source, so its blind spots are the interesting
  // part. These pin the two it must not have (a subject named anything but
  // `text`, an expected statement built elsewhere) and the one it accepts on
  // purpose: SQL keywords are matched case-sensitively, because `from`, `join`
  // and `where` are also ordinary English and prompt/error-message assertions
  // are full of them.
  const CASES: Array<{ snippet: string; flagged: boolean; why: string }> = [
    { snippet: `expect(captured.text).toContain("INSERT INTO widgets")`, flagged: true, why: "the canonical form" },
    { snippet: `expect(sql).toContain("FROM calls")`, flagged: true, why: "subject aliased to `sql`" },
    { snippet: `expect(reRead).toContain("SELECT s.workspace_id")`, flagged: true, why: "subject named nothing in particular" },
    { snippet: `expect(availableQuery).toContain("CASE WHEN i.trigger = 'x' THEN 1 END")`, flagged: true, why: "`*Query` suffix" },
    { snippet: `expect(captured.text).toContain(expectedSql)`, flagged: true, why: "expected statement built elsewhere" },
    { snippet: `expect(queries[0]!.text).not.toContain("ORDER BY")`, flagged: true, why: "negated, and indexed" },
    { snippet: `expect(text).toMatch(/DELETE FROM saved_messages/)`, flagged: true, why: "regex literal, not a string" },
    { snippet: `expect(result).toBe("Message from deleted user")`, flagged: false, why: "lowercase `from` is English" },
    { snippet: `expect(prompt).toContain("## Discussion This Was Spawned From")`, flagged: false, why: "`From` is not `FROM`" },
    { snippet: `expect(err.message).toBe("Can only join public channels")`, flagged: false, why: "lowercase `join` is English" },
    { snippet: `expect(captured.publicKey).toEqual(Buffer.from([1, 2]))`, flagged: false, why: "`Buffer.from` is not SQL" },
    { snippet: `if (text.includes("INSERT INTO widgets")) return rows`, flagged: false, why: "routing, not asserting" },
  ]

  test.each(CASES)("$why", ({ snippet, flagged }) => {
    expect(assertions(snippet).some(assertsOnSql)).toBe(flagged)
  })
})
