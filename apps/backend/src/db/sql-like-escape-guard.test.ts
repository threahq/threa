import { describe, test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../../..")
const SCANNED_GLOBS = [
  "apps/backend/src/**/*.ts",
  "apps/control-plane/src/**/*.ts",
  "packages/backend-common/src/**/*.ts",
]

/**
 * Guard: a SQL `ESCAPE` clause written inside a TS template literal must be
 * spelled `ESCAPE '\\'` in source. The obvious spelling `ESCAPE '\'` cooks to
 * `ESCAPE ''` (JS eats the backslash), which Postgres accepts as "no escape
 * character" — silently disabling LIKE-pattern escaping, so escaped `_`/`%`
 * become live wildcards or dead literals. Caught live on #1374: underscore repo
 * names never matched webhook refreshes. Invisible to unit tests that mock the
 * repository, hence a source-level guard.
 */
describe("SQL LIKE ESCAPE clauses survive template-literal cooking", () => {
  test("every ESCAPE clause is spelled with a double backslash in source", async () => {
    const offenders: string[] = []
    for (const globPattern of SCANNED_GLOBS) {
      const glob = new Bun.Glob(globPattern)
      for await (const path of glob.scan({ cwd: REPO_ROOT })) {
        if (path.endsWith(".test.ts")) continue
        const source = await readFile(resolve(REPO_ROOT, path), "utf-8")
        // Positional check: after every `ESCAPE '` the source must continue with
        // exactly `\\'` (two backslashes + closing quote). Anything else — one
        // backslash, empty, a different character — is either already broken or
        // cooks broken. A content-capturing regex can't express this: the broken
        // spelling `ESCAPE '\'` swallows its own closing quote and simply fails
        // to match, hiding the offender.
        for (const match of source.matchAll(/ESCAPE\s+'/g)) {
          const rest = source.slice(match.index + match[0].length, match.index + match[0].length + 3)
          if (rest !== "\\\\'") {
            offenders.push(`${path}: ESCAPE '${rest}…`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
