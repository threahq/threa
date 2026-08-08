import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../../../..")
const SCANNED_GLOBS = [
  "apps/backend/src/**/*.ts",
  "apps/enclave/src/**/*.ts",
  "apps/frontend/src/**/*.ts",
  "packages/types/src/**/*.ts",
]
const RETIRED = [
  ["displayName", "GeneratedAt"].join(""),
  ["display_name", "_generated_at"].join(""),
  ["auto", "Title"].join(""),
  ["NOT_ENOUGH", "_CONTEXT"].join(""),
  ["require", "Name"].join(""),
  ["naming", ".generate"].join(""),
  ["setSealedName", "IfAbsent"].join(""),
  ["coordinated", "_title_write"].join(""),
  ["EnclaveSealed", "Name"].join(""),
]

describe("dynamic naming compatibility cleanup", () => {
  test("retired rollout identifiers do not return to production source", async () => {
    const offenders: string[] = []
    for (const pattern of SCANNED_GLOBS) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) {
        if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue
        const source = await readFile(resolve(REPO_ROOT, path), "utf8")
        for (const identifier of RETIRED) {
          if (source.includes(identifier)) offenders.push(`${path}: ${identifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
