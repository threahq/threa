import { describe, test, expect } from "bun:test"
import { ESLint, type Linter } from "eslint"
import tsParser from "@typescript-eslint/parser"
import threaPlugin, { unscopedSqlAllowlist } from "../../../../eslint/threa-plugin.js"

/**
 * The ratchet half of INV-8: every statement constrains the `workspace_id` of
 * each workspace-scoped table it reads or writes.
 *
 * Threa Connect holds read-only copies of a shared stream's rows in a partner
 * workspace under the SAME ids and a different `workspace_id`. A statement that
 * finds a row by id, or by a foreign key alone (`WHERE id = $1`,
 * `JOIN streams s ON s.id = m.stream_id`), can then match the copy in the other
 * workspace.
 *
 * DETECTION lives in the `threa/workspace-scoped-sql` ESLint rule, so a
 * violation is red in the editor and fails `bun run lint`. What ESLint cannot do
 * is notice a count going DOWN — it only ever sees the violations that remain.
 * That is this test's job: it runs the rule alone over the backend's source and
 * holds each file to its recorded number, so fixing a statement must be
 * recorded, and adding an unscoped one cannot pass unnoticed.
 */

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "")
const RULE = "threa/workspace-scoped-sql"

async function countViolations(): Promise<Record<string, number>> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    // The rule alone, ignoring every project config, so the whole tree is held to one standard.
    overrideConfig: [
      { ignores: ["**/*.test.ts", "**/migrations/**"] },
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser as Linter.Parser,
          parserOptions: { ecmaVersion: "latest", sourceType: "module" },
        },
        plugins: { threa: threaPlugin },
        rules: { [RULE]: "error" },
      },
    ],
  })
  const results = await eslint.lintFiles(["apps/backend/src/**/*.ts"])
  const counts: Record<string, number> = {}
  for (const result of results) {
    const fatal = result.messages.find((message) => message.fatal)
    if (fatal) throw new Error(`${result.filePath} failed to parse: ${fatal.message}`)
    const count = result.messages.filter((message) => message.ruleId === RULE).length
    if (count > 0) counts[result.filePath.slice(REPO_ROOT.length + 1)] = count
  }
  return counts
}

describe("every SQL statement constrains workspace_id on the workspace-scoped tables it touches", () => {
  test("no file holds more unscoped table references than its recorded ratchet", async () => {
    const found = await countViolations()

    const offences = [...new Set([...Object.keys(found), ...Object.keys(unscopedSqlAllowlist)])]
      .sort()
      .filter((path) => (found[path] ?? 0) !== (unscopedSqlAllowlist[path] ?? 0))
      .map((path) => `${path}: allowed ${unscopedSqlAllowlist[path] ?? 0}, found ${found[path] ?? 0}`)

    expect(
      offences,
      `Unscoped SQL references moved off their recorded baseline.\n\n` +
        `Went UP, or a file appeared: a copy of the row can exist in another ` +
        `workspace under the same id (INV-8). Scope the statement — constrain ` +
        `<alias>.workspace_id, or name workspace_id in the INSERT column list. ` +
        `If it is cross-workspace by design (queue claims, sweepers, lookups by a ` +
        `global secret such as a key hash), add ` +
        `\`// eslint-disable-next-line threa/workspace-scoped-sql -- <reason>\`.\n\n` +
        `Went DOWN: thank you — lower the number in unscopedSqlAllowlist ` +
        `(eslint/threa-plugin.js), or delete the entry.\n\n${offences.join("\n")}`
    ).toEqual([])
  }, 120_000)
})
